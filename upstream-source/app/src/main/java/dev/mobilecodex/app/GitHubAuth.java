package dev.mobilecodex.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import dev.mobilecodex.app.core.GitHubAuthPolicy;
import org.json.JSONArray;
import org.json.JSONObject;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.HttpsURLConnection;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import static dev.mobilecodex.app.core.Json.obj;

/** Native-only GitHub Device Flow. Device codes, tokens and refresh tokens never reach the WebView. */
public final class GitHubAuth implements AutoCloseable {
    public interface Listener { void changed(JSONObject safeStatus); }
    interface KeyCipher { JSONObject seal(String value) throws Exception; String open(JSONObject value) throws Exception; }
    interface TimeSource { long nowMillis(); long elapsedMillis(); }
    interface Network { Response exchange(String method, String url, Map<String, String> form, String token) throws IOException; }
    static final class Response {
        final int status;
        final JSONObject body;
        final String scopes;
        Response(int status, JSONObject body) { this(status, body, ""); }
        Response(int status, JSONObject body, String scopes) { this.status = status; this.body = body; this.scopes = scopes == null ? "" : scopes; }
    }

    private final SharedPreferences preferences;
    private final KeyCipher cipher;
    private final Network network;
    private final ScheduledExecutorService executor;
    private final TimeSource clock;
    private final Listener listener;
    private String clientId = "", state = "idle", login = "", error = "", token = "";
    private List<String> scopes = GitHubAuthPolicy.REQUESTED_SCOPES;
    private long generation, tokenExpiry, tokenDeadline;
    private Session pending;
    private ScheduledFuture<?> scheduled;
    private boolean closed;

    private static final class Session {
        final long generation, expiresAt, deadline;
        final String clientId, deviceCode, userCode, verificationUri;
        long intervalMillis;
        Session(long generation, String clientId, JSONObject body, long beganWall, long beganElapsed) throws IOException {
            this.generation = generation; this.clientId = clientId;
            deviceCode = GitHubAuthPolicy.deviceCode(body.optString("device_code"));
            userCode = GitHubAuthPolicy.userCode(body.optString("user_code"));
            verificationUri = GitHubAuthPolicy.verificationUri(body.optString("verification_uri"));
            long lifetime = GitHubAuthPolicy.deviceLifetimeSeconds(body.opt("expires_in"));
            expiresAt = GitHubAuthPolicy.deadline(beganWall, lifetime);
            deadline = GitHubAuthPolicy.deadline(beganElapsed, lifetime);
            intervalMillis = GitHubAuthPolicy.pollIntervalMillis(body.opt("interval"));
        }
    }

    public GitHubAuth(Context context, Listener listener) {
        this(context.getSharedPreferences("github-auth-v1", Context.MODE_PRIVATE), new AndroidKeyCipher(), new HttpNetwork(),
            Executors.newSingleThreadScheduledExecutor(runnable -> { Thread thread = new Thread(runnable, "github-auth"); thread.setDaemon(true); return thread; }),
            new TimeSource() { public long nowMillis() { return System.currentTimeMillis(); } public long elapsedMillis() { return SystemClock.elapsedRealtime(); } }, listener);
    }

    GitHubAuth(SharedPreferences preferences, KeyCipher cipher, Network network, ScheduledExecutorService executor, TimeSource clock, Listener listener) {
        this.preferences = preferences; this.cipher = cipher; this.network = network; this.executor = executor; this.clock = clock; this.listener = listener;
        try {
            clientId = GitHubAuthPolicy.clientId(preferences.getString("clientId", ""));
            String encrypted = preferences.getString("credential", "");
            if (!encrypted.isEmpty() && !clientId.isEmpty()) {
                JSONObject record = new JSONObject(cipher.open(new JSONObject(encrypted)));
                if (!clientId.equals(record.optString("clientId"))) throw new IOException();
                String restored = GitHubAuthPolicy.accessToken(record.optString("token"));
                login = GitHubAuthPolicy.login(record.optString("login"));
                scopes = GitHubAuthPolicy.scopes(record.optString("scope")); GitHubAuthPolicy.requireScopes(scopes);
                tokenExpiry = record.optLong("expiresAt");
                if (tokenExpiry < 0) throw new IOException();
                tokenDeadline = tokenExpiry == 0 ? 0 : Math.addExact(clock.elapsedMillis(), Math.max(0, tokenExpiry - clock.nowMillis()));
                if (tokenExpiry > 0 && clock.nowMillis() >= tokenExpiry) { state = "expired"; error = "GitHub 授权凭据已过期，请重新授权。"; }
                else { token = restored; state = "connected"; scheduleTokenExpiryLocked(); }
            }
        } catch (Exception ignored) {
            token = ""; login = ""; tokenExpiry = 0; tokenDeadline = 0; scopes = GitHubAuthPolicy.REQUESTED_SCOPES;
            state = "error"; error = "无法读取本地 GitHub 设置或凭据，请重新配置并授权。";
        }
    }

    public synchronized JSONObject status() {
        refreshExpiryLocked();
        return snapshotLocked();
    }

    /** Model/shell context excludes device codes, client IDs and credential material. */
    synchronized JSONObject agentStatus() {
        refreshExpiryLocked();
        return obj("state", state, "login", login, "scopes", new JSONArray(scopes));
    }

    private JSONObject snapshotLocked() {
        return obj("github", obj("configured", !clientId.isEmpty(), "clientId", clientId, "state", state,
            "login", login, "userCode", pending == null ? "" : pending.userCode,
            "verificationUri", pending == null ? "" : pending.verificationUri,
            "expiresAt", pending == null ? tokenExpiry : pending.expiresAt, "error", error, "scopes", new JSONArray(scopes)));
    }

    /** Callbacks carry safe snapshots and must return promptly. Reentrant status() reads are supported. */
    private void changedLocked() {
        if (listener != null && !closed) try { listener.changed(snapshotLocked()); } catch (RuntimeException ignored) {}
    }

    public synchronized void configure(String value) throws IOException {
        requireOpen();
        String next = GitHubAuthPolicy.clientId(value);
        if (next.equals(clientId)) { refreshExpiryLocked(); changedLocked(); return; }
        if (!preferences.edit().putString("clientId", next).remove("credential").commit())
            throw new IOException("无法保存 GitHub Client ID，请重试。");
        invalidateLocked(); clearCredentialLocked(); clientId = next; state = "idle"; error = ""; changedLocked();
    }

    /** Only queues work; this method never performs a network request on its caller. */
    public synchronized void begin() throws IOException {
        requireOpen(); refreshExpiryLocked();
        if (clientId.isEmpty()) throw new IOException("请先填写自己注册的 GitHub OAuth App 的公开 Client ID，并启用 Device Flow。");
        if ("connected".equals(state)) { changedLocked(); return; }
        invalidateLocked(); clearCredentialLocked(); state = "requesting"; error = ""; changedLocked();
        long current = generation, beganWall = clock.nowMillis(), beganElapsed = clock.elapsedMillis(); String id = clientId;
        try { scheduled = executor.schedule(() -> requestCode(current, id, beganWall, beganElapsed), 0, TimeUnit.MILLISECONDS); }
        catch (RuntimeException ignored) { finishLocked("error", "无法启动 GitHub 授权，请稍后重试。"); throw new IOException(error); }
    }

    public synchronized void cancel() {
        if (closed) return;
        refreshExpiryLocked();
        if (!"requesting".equals(state) && !"pending".equals(state)) return;
        invalidateLocked(); state = "idle"; error = ""; changedLocked();
    }

    /** Disconnects this installation only; it does not revoke or modify the GitHub account. */
    public synchronized void disconnect() throws IOException {
        requireOpen(); invalidateLocked(); clearCredentialLocked(); state = "idle"; error = "";
        boolean saved = preferences.edit().remove("credential").commit();
        if (!saved) { state = "error"; error = "未能删除本地 GitHub 凭据，请重试断开连接。"; }
        changedLocked(); if (!saved) throw new IOException(error);
    }

    public synchronized String verificationUri() {
        refreshExpiryLocked();
        return !closed && "pending".equals(state) && pending != null ? pending.verificationUri : "";
    }

    /** Native Git credential helper only. The returned password must never be sent through the UI bridge. */
    public synchronized String credentialFor(String protocol, String host, String path) throws IOException {
        refreshExpiryLocked();
        if (closed || !"connected".equals(state) || !GitHubAuthPolicy.credentialAllowed(protocol, host, path)) return "";
        return token;
    }

    @Override public synchronized void close() {
        if (closed) return;
        invalidateLocked(); clearCredentialLocked(); closed = true; executor.shutdownNow();
    }

    private void requireOpen() throws IOException { if (closed) throw new IOException("GitHub 授权服务已关闭。"); }
    private void clearCredentialLocked() { token = ""; login = ""; tokenExpiry = 0; tokenDeadline = 0; scopes = GitHubAuthPolicy.REQUESTED_SCOPES; }
    private void invalidateLocked() {
        generation++;
        if (scheduled != null) scheduled.cancel(false);
        scheduled = null; pending = null;
    }
    private void finishLocked(String next, String detail) { invalidateLocked(); state = next; error = detail; changedLocked(); }
    private boolean currentLocked(long value) { return !closed && generation == value; }
    private boolean currentLocked(Session session) { return currentLocked(session.generation) && pending == session && "pending".equals(state); }
    private boolean expiredLocked(Session session) {
        if (clock.elapsedMillis() < session.deadline) return false;
        finishLocked("expired", "GitHub 设备验证码已过期，请重新授权。"); return true;
    }
    private void refreshExpiryLocked() {
        if (closed) return;
        if (pending != null && "pending".equals(state)) { expiredLocked(pending); return; }
        if ("connected".equals(state) && tokenExpiry > 0 && (clock.nowMillis() >= tokenExpiry || clock.elapsedMillis() >= tokenDeadline)) {
            token = ""; finishLocked("expired", "GitHub 授权凭据已过期，请重新授权。");
        }
    }
    private void scheduleTokenExpiryLocked() {
        if (tokenExpiry == 0) return;
        long current = generation;
        scheduled = executor.schedule(() -> { synchronized (GitHubAuth.this) { if (currentLocked(current)) refreshExpiryLocked(); } },
            Math.max(0, tokenDeadline - clock.elapsedMillis()), TimeUnit.MILLISECONDS);
    }

    private void requestCode(long current, String id, long beganWall, long beganElapsed) {
        try {
            synchronized (this) { if (!currentLocked(current)) return; }
            Response response = network.exchange("POST", GitHubAuthPolicy.DEVICE_URL,
                Map.of("client_id", id, "scope", GitHubAuthPolicy.REQUESTED_SCOPE), "");
            synchronized (this) {
                if (!currentLocked(current)) return;
                if (response.status != 200 || response.body.has("error")) { finishLocked("error", deviceError(response)); return; }
                Session session = new Session(current, id, response.body, beganWall, beganElapsed);
                pending = session; state = "pending";
                if (expiredLocked(session)) return;
                changedLocked(); schedulePollLocked(session);
            }
        } catch (Exception ignored) { fail(current, "无法获取 GitHub 设备验证码，请检查网络、Client ID 与 Device Flow 设置。"); }
    }

    private String deviceError(Response response) {
        return "device_flow_disabled".equals(response.body.optString("error"))
            ? "此 GitHub OAuth App 尚未启用 Device Flow，请先在应用设置中启用。"
            : "获取 GitHub 设备验证码失败，请检查网络、Client ID 与 Device Flow 设置。";
    }

    private void schedulePollLocked(Session session) {
        scheduled = executor.schedule(() -> poll(session), Math.max(0, Math.min(session.intervalMillis, session.deadline - clock.elapsedMillis())), TimeUnit.MILLISECONDS);
    }

    private void poll(Session session) {
        long beganWall, beganElapsed;
        synchronized (this) {
            if (!currentLocked(session) || expiredLocked(session)) return;
            beganWall = clock.nowMillis(); beganElapsed = clock.elapsedMillis();
        }
        try {
            Response response = network.exchange("POST", GitHubAuthPolicy.TOKEN_URL,
                Map.of("client_id", session.clientId, "device_code", session.deviceCode, "grant_type", "urn:ietf:params:oauth:grant-type:device_code"), "");
            synchronized (this) {
                if (!currentLocked(session) || expiredLocked(session)) return;
                if (response.status != 200 && response.status != 400) { finishLocked("error", "GitHub 授权请求失败，请重新授权。"); return; }
                String problem = response.body.optString("error");
                if (!problem.isEmpty()) {
                    switch (problem) {
                        case "authorization_pending" -> schedulePollLocked(session);
                        case "slow_down" -> {
                            session.intervalMillis = Math.max(session.intervalMillis + 5000, GitHubAuthPolicy.pollIntervalMillis(response.body.opt("interval")));
                            schedulePollLocked(session);
                        }
                        case "access_denied" -> finishLocked("denied", "已拒绝 GitHub 授权，可重新发起授权。");
                        case "expired_token", "token_expired" -> finishLocked("expired", "GitHub 设备验证码已过期，请重新授权。");
                        case "device_flow_disabled" -> finishLocked("error", "此 GitHub OAuth App 尚未启用 Device Flow。");
                        default -> finishLocked("error", "GitHub 授权凭据无效，请检查 Client ID 并重新授权。");
                    }
                    return;
                }
                if (response.status != 200) { finishLocked("error", "GitHub 授权请求失败，请重新授权。"); return; }
            }
            complete(session, response, beganWall, beganElapsed);
        } catch (Exception ignored) { fail(session.generation, "连接 GitHub 授权服务失败，请检查网络并重新授权。"); }
    }

    private void complete(Session session, Response response, long beganWall, long beganElapsed) throws IOException {
        final String grantedToken;
        final List<String> grantedScopes;
        final long lifetime, expiresAt, deadline;
        try {
            grantedToken = GitHubAuthPolicy.accessToken(response.body.optString("access_token"));
            if (!"bearer".equalsIgnoreCase(response.body.optString("token_type", "bearer"))) throw new IOException("GitHub 返回的凭据类型无效，请重新授权。");
            grantedScopes = GitHubAuthPolicy.scopes(response.body.optString("scope")); GitHubAuthPolicy.requireScopes(grantedScopes);
            lifetime = GitHubAuthPolicy.tokenLifetimeSeconds(response.body.opt("expires_in"));
            expiresAt = lifetime == 0 ? 0 : GitHubAuthPolicy.deadline(beganWall, lifetime);
            deadline = lifetime == 0 ? 0 : GitHubAuthPolicy.deadline(beganElapsed, lifetime);
        } catch (IOException problem) { fail(session.generation, problem.getMessage()); return; }
        synchronized (this) { if (!currentLocked(session) || expiredLocked(session)) return; }
        Response user = network.exchange("GET", GitHubAuthPolicy.USER_URL, Map.of(), grantedToken);
        synchronized (this) {
            if (!currentLocked(session) || expiredLocked(session)) return;
            if (user.status != 200) { finishLocked("error", "GitHub 授权凭据无效或无法验证账号，请重新授权。"); return; }
            try {
                String account = GitHubAuthPolicy.login(user.body.optString("login"));
                List<String> verifiedScopes = user.scopes.isBlank() ? grantedScopes : GitHubAuthPolicy.scopes(user.scopes);
                GitHubAuthPolicy.requireScopes(verifiedScopes);
                if (expiresAt > 0 && (clock.nowMillis() >= expiresAt || clock.elapsedMillis() >= deadline)) {
                    finishLocked("expired", "GitHub 授权凭据已过期，请重新授权。"); return;
                }
                final JSONObject encrypted;
                try { encrypted = cipher.seal(obj("clientId", session.clientId, "token", grantedToken, "login", account,
                    "scope", String.join(",", verifiedScopes), "expiresAt", expiresAt).toString()); }
                catch (Exception ignored) { finishLocked("error", "无法加密并保存 GitHub 凭据，请重新授权。"); return; }
                if (!preferences.edit().putString("credential", encrypted.toString()).commit()) throw new IOException("无法保存本地 GitHub 凭据，请重新授权。");
                invalidateLocked(); token = grantedToken; login = account; scopes = verifiedScopes;
                tokenExpiry = expiresAt; tokenDeadline = deadline; state = "connected"; error = "";
                scheduleTokenExpiryLocked(); changedLocked();
            } catch (IOException problem) { finishLocked("error", problem.getMessage()); }
            catch (Exception ignored) { finishLocked("error", "无法加密并保存 GitHub 凭据，请重新授权。"); }
        }
    }

    private synchronized void fail(long current, String detail) { if (currentLocked(current)) finishLocked("error", detail); }

    private static final class HttpNetwork implements Network {
        @Override public Response exchange(String method, String address, Map<String, String> form, String token) throws IOException {
            if (!GitHubAuthPolicy.endpointAllowed(method, address)) throw new IOException("不支持的 GitHub 授权接口。");
            HttpsURLConnection connection = null;
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(25);
            try {
                connection = (HttpsURLConnection) new URL(address).openConnection();
                connection.setRequestMethod(method); connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
                connection.setConnectTimeout(12000); connection.setReadTimeout(12000);
                connection.setRequestProperty("Accept", "application/json"); connection.setRequestProperty("User-Agent", "Mobile-Codex-Android");
                if (!token.isEmpty()) { connection.setRequestProperty("Authorization", "Bearer " + token); connection.setRequestProperty("X-GitHub-Api-Version", "2022-11-28"); }
                if ("POST".equals(method)) {
                    StringBuilder body = new StringBuilder();
                    for (Map.Entry<String, String> field : new LinkedHashMap<>(form).entrySet()) {
                        if (body.length() > 0) body.append('&');
                        body.append(URLEncoder.encode(field.getKey(), "UTF-8")).append('=').append(URLEncoder.encode(field.getValue(), "UTF-8"));
                    }
                    byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                    connection.setDoOutput(true); connection.setFixedLengthStreamingMode(bytes.length);
                    connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                    try (java.io.OutputStream output = connection.getOutputStream()) { output.write(bytes); }
                }
                connection.setReadTimeout(readTimeout(deadline));
                int code = connection.getResponseCode();
                if (code >= 300 && code < 400) throw new IOException("GitHub 授权接口返回了不支持的重定向。");
                if (connection.getContentLengthLong() > GitHubAuthPolicy.MAX_RESPONSE_BYTES) throw new IOException("GitHub 授权响应过大。");
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                try (InputStream input = code >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
                    if (input == null) return new Response(code, obj());
                    byte[] bytes = new byte[4096]; int count;
                    while (true) {
                        connection.setReadTimeout(readTimeout(deadline)); count = input.read(bytes); if (count == -1) break;
                        if (buffer.size() + count > GitHubAuthPolicy.MAX_RESPONSE_BYTES) throw new IOException("GitHub 授权响应过大。");
                        buffer.write(bytes, 0, count);
                    }
                }
                return new Response(code, new JSONObject(buffer.toString(StandardCharsets.UTF_8.name())), connection.getHeaderField("X-OAuth-Scopes"));
            } catch (Exception ignored) { throw new IOException("连接 GitHub 授权接口失败，请稍后重试。"); }
            finally { if (connection != null) connection.disconnect(); }
        }

        private static int readTimeout(long deadline) throws IOException {
            long remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
            if (remaining <= 0) throw new IOException("GitHub 授权请求超时。");
            return (int) Math.max(1, Math.min(12000, remaining));
        }
    }

    private static final class AndroidKeyCipher implements KeyCipher {
        private static final String ALIAS = "mobile-codex.github-auth.v1";
        private SecretKey key(boolean create) throws Exception {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
            if (!store.containsAlias(ALIAS)) {
                if (!create) throw new IOException("GitHub 凭据加密密钥不可用。");
                KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
                generator.generateKey();
            }
            return (SecretKey) store.getKey(ALIAS, null);
        }
        @Override public JSONObject seal(String value) throws Exception {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key(true));
            return obj("iv", Base64.getEncoder().encodeToString(cipher.getIV()),
                "ciphertext", Base64.getEncoder().encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8))));
        }
        @Override public String open(JSONObject encrypted) throws Exception {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Base64.getDecoder().decode(encrypted.getString("iv"))));
            return new String(cipher.doFinal(Base64.getDecoder().decode(encrypted.getString("ciphertext"))), StandardCharsets.UTF_8);
        }
    }
}
