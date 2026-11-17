package dev.mobilecodex.app;

import android.app.Application;
import android.content.SharedPreferences;
import dev.mobilecodex.app.core.GitHubAuthPolicy;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.Callable;
import java.util.concurrent.Delayed;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import static dev.mobilecodex.app.core.Json.obj;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 29, application = Application.class)
public class GitHubAuthTest {
    private static final String CLIENT = "Iv1.project-fixture";
    private static final String DEVICE = "fixture-private-device-code";
    private static final String TOKEN = "fixture-private-access-token";
    private static final String REFRESH = "fixture-private-refresh-token";
    private SharedPreferences preferences;
    private FakeClock clock;
    private ManualScheduler scheduler;
    private ScriptNetwork network;
    private GitHubAuth auth;
    private final List<String> events = new ArrayList<>();

    @Before public void before() {
        preferences = RuntimeEnvironment.getApplication().getSharedPreferences("github-auth-tests", 0);
        preferences.edit().clear().commit();
        clock = new FakeClock(); scheduler = new ManualScheduler(clock); network = new ScriptNetwork();
        auth = create(scheduler);
    }
    @After public void after() { auth.close(); preferences.edit().clear().commit(); }
    private GitHubAuth create(ManualScheduler queue) { return new GitHubAuth(preferences, new FixtureCipher(), network, queue, clock, value -> events.add(value.toString())); }
    private JSONObject github() throws Exception { return auth.status().getJSONObject("github"); }
    private String state() throws Exception { return github().getString("state"); }
    private static GitHubAuth.Response device(int expiry, int interval) {
        return new GitHubAuth.Response(200, obj("device_code", DEVICE, "user_code", "ABCD-EFGH", "verification_uri", GitHubAuthPolicy.VERIFICATION_URI, "expires_in", expiry, "interval", interval));
    }
    private static GitHubAuth.Response token(String scope, int expiry) {
        JSONObject body = obj("access_token", TOKEN, "token_type", "bearer", "scope", scope, "refresh_token", REFRESH);
        if (expiry > 0) try { body.put("expires_in", expiry); } catch (Exception error) { throw new AssertionError(error); }
        return new GitHubAuth.Response(200, body);
    }
    private void pending(int expiry, int interval) throws Exception {
        auth.configure(CLIENT); network.add(device(expiry, interval)); auth.begin();
        assertEquals("requesting", state()); assertTrue(network.requests.isEmpty());
        scheduler.runNext(); assertEquals("pending", state());
    }
    private void connected(int expiry) throws Exception {
        pending(900, 5); network.add(token("public_repo,workflow", expiry)); network.add(new GitHubAuth.Response(200, obj("login", "fixture-user")));
        scheduler.runNext(); assertEquals("connected", state());
    }

    @Test public void requiresOwnClientIdAndQueuesNetworkInsteadOfCallingInline() throws Exception {
        assertFalse(github().getBoolean("configured"));
        assertThrows(IOException.class, () -> auth.begin());
        assertTrue(network.requests.isEmpty());
        pending(900, 1);
        assertEquals(5000, scheduler.nextDelay());
        Request request = network.requests.get(0);
        assertEquals("POST", request.method); assertEquals(GitHubAuthPolicy.DEVICE_URL, request.url);
        assertEquals(Map.of("client_id", CLIENT, "scope", "public_repo workflow"), request.form);
        assertEquals("", request.token);
        assertEquals("ABCD-EFGH", github().getString("userCode"));
        assertEquals(GitHubAuthPolicy.VERIFICATION_URI, auth.verificationUri());
        assertFalse(preferences.getAll().toString().contains(DEVICE));
    }

    @Test public void successfulLoginEncryptsOnlyNeededCredentialAndNeverPublishesSecrets() throws Exception {
        connected(0);
        assertEquals("fixture-user", github().getString("login")); assertEquals("", github().getString("userCode"));
        assertEquals("", auth.verificationUri());
        assertEquals(TOKEN, auth.credentialFor("https", "github.com", "owner/project.git"));
        String persisted = preferences.getAll().toString(), published = events.toString() + auth.status();
        for (String secret : List.of(TOKEN, DEVICE, REFRESH)) { assertFalse(persisted.contains(secret)); assertFalse(published.contains(secret)); }
        String plain = new FixtureCipher().open(new JSONObject(preferences.getString("credential", "")));
        assertTrue(plain.contains(TOKEN)); assertFalse(plain.contains(DEVICE)); assertFalse(plain.contains(REFRESH));
        Request poll = network.requests.get(1), user = network.requests.get(2);
        assertEquals(GitHubAuthPolicy.TOKEN_URL, poll.url); assertEquals(DEVICE, poll.form.get("device_code"));
        assertEquals("urn:ietf:params:oauth:grant-type:device_code", poll.form.get("grant_type"));
        assertEquals(GitHubAuthPolicy.USER_URL, user.url); assertEquals("GET", user.method); assertEquals(TOKEN, user.token);
        auth.close(); scheduler = new ManualScheduler(clock); auth = create(scheduler);
        assertEquals("connected", state()); assertEquals(TOKEN, auth.credentialFor("https", "github.com", ""));
    }

    @Test public void pendingAndSlowDownRespectServerIntervalsWithoutBlockingSleeps() throws Exception {
        pending(900, 7); assertEquals(7000, scheduler.nextDelay());
        network.add(new GitHubAuth.Response(200, obj("error", "authorization_pending"))); scheduler.runNext();
        assertEquals(7000, scheduler.nextDelay());
        network.add(new GitHubAuth.Response(200, obj("error", "slow_down", "interval", 20))); scheduler.runNext();
        assertEquals(20000, scheduler.nextDelay());
        network.add(new GitHubAuth.Response(400, obj("error", "slow_down"))); scheduler.runNext();
        assertEquals(25000, scheduler.nextDelay()); assertEquals("pending", state());
    }

    @Test public void expiredDeviceCodeStopsBeforeAnyTokenRequestEvenWhenIntervalIsLonger() throws Exception {
        pending(3, 5); assertEquals(3000, scheduler.nextDelay()); scheduler.runNext();
        assertEquals("expired", state()); assertEquals("", github().getString("userCode"));
        assertEquals("", auth.verificationUri()); assertEquals(1, network.requests.size()); assertFalse(scheduler.hasTasks());
    }

    @Test public void denialExpiryAndInvalidTokenErrorsTerminateWithSafeMessages() throws Exception {
        for (String problem : List.of("access_denied", "expired_token", "token_expired", "incorrect_client_credentials")) {
            auth.configure(CLIENT); network.add(device(900, 5)); auth.begin(); scheduler.runNext();
            network.add(new GitHubAuth.Response(200, obj("error", problem, "error_description", "private-server-secret"))); scheduler.runNext();
            assertEquals(problem.equals("access_denied") ? "denied" : problem.contains("expired") ? "expired" : "error", state());
            assertFalse(auth.status().toString().contains("private-server-secret")); assertFalse(scheduler.hasTasks());
            assertFalse(preferences.contains("credential"));
        }
    }

    @Test public void insufficientOrBroaderPermissionsCannotBecomeConnected() throws Exception {
        for (String scope : List.of("public_repo", "repo,workflow", "public_repo,workflow,read:user")) {
            auth.configure(CLIENT); network.add(device(900, 5)); auth.begin(); scheduler.runNext();
            network.add(token(scope, 0)); scheduler.runNext();
            assertEquals("error", state()); assertFalse(preferences.contains("credential"));
            assertEquals("", auth.credentialFor("https", "github.com", "owner/project.git"));
            assertTrue(github().getString("error").contains(scope.equals("public_repo") ? "范围不足" : "权限过宽"));
        }
        assertEquals(6, network.requests.size());
    }

    @Test public void actualUserAndResponseScopeMustBeVerifiedBeforePersistence() throws Exception {
        pending(900, 5); network.add(token("public_repo,workflow", 0)); network.add(new GitHubAuth.Response(401, obj("message", TOKEN)));
        scheduler.runNext(); assertEquals("error", state()); assertFalse(preferences.contains("credential"));
        assertFalse(auth.status().toString().contains(TOKEN));
        network.add(device(900, 5)); auth.begin(); scheduler.runNext();
        network.add(token("public_repo,workflow", 0)); network.add(new GitHubAuth.Response(200, obj("login", "fixture-user"), "repo,workflow"));
        scheduler.runNext(); assertEquals("error", state()); assertTrue(github().getString("error").contains("权限过宽"));
        assertFalse(preferences.contains("credential"));
    }

    @Test public void cancellationWhileOldUserRequestCompletesCannotOverwriteNewAuthorization() throws Exception {
        pending(900, 5); network.add(token("public_repo,workflow", 0));
        network.add(request -> {
            assertEquals(GitHubAuthPolicy.USER_URL, request.url);
            auth.cancel(); auth.begin(); return new GitHubAuth.Response(200, obj("login", "stale-user"));
        });
        scheduler.runNext(); assertEquals("requesting", state()); assertFalse(preferences.contains("credential"));
        network.add(device(900, 5)); scheduler.runNext();
        network.add(token("public_repo,workflow", 0)); network.add(new GitHubAuth.Response(200, obj("login", "new-user"))); scheduler.runNext();
        assertEquals("connected", state()); assertEquals("new-user", github().getString("login"));
        assertFalse(events.toString().contains("stale-user"));
    }

    @Test public void cancellationWhileDeviceResponseArrivesDoesNotRestoreOldCode() throws Exception {
        auth.configure(CLIENT);
        network.add(request -> { auth.cancel(); return device(900, 5); });
        auth.begin(); scheduler.runNext(); assertEquals("idle", state()); assertEquals("", github().getString("userCode"));
        assertFalse(scheduler.hasTasks()); assertFalse(preferences.contains("credential"));
    }

    @Test public void disconnectDeletesOnlyLocalCredentialAndCancelsAllPendingWork() throws Exception {
        connected(100); int calls = network.requests.size(); auth.disconnect();
        assertEquals("idle", state()); assertTrue(github().getBoolean("configured"));
        assertFalse(preferences.contains("credential")); assertEquals("", auth.credentialFor("https", "github.com", ""));
        assertFalse(scheduler.hasTasks()); assertEquals(calls, network.requests.size());
        network.add(device(900, 5)); auth.begin(); scheduler.runNext(); auth.disconnect();
        assertFalse(scheduler.hasTasks()); assertEquals("idle", state());
    }

    @Test public void tokenExpiryIsEnforcedDuringUseAndAfterRestartWithoutKeepingRefreshToken() throws Exception {
        connected(10); long expiry = github().getLong("expiresAt");
        clock.advance(10000);
        assertEquals("", auth.credentialFor("https", "github.com", "owner/project.git"));
        assertEquals("expired", state()); assertEquals(expiry, github().getLong("expiresAt"));
        auth.close(); scheduler = new ManualScheduler(clock); auth = create(scheduler);
        assertEquals("expired", state()); assertEquals("", auth.credentialFor("https", "github.com", ""));
        assertFalse(scheduler.hasTasks());
    }

    @Test public void changingClientIdOrClosingPreventsCredentialReuseAndHostConfusion() throws Exception {
        connected(0);
        for (String host : List.of("github.com.evil.test", "github.com:443", "user@github.com"))
            assertEquals("", auth.credentialFor("https", host, "owner/project.git"));
        assertEquals("", auth.credentialFor("http", "github.com", "owner/project.git"));
        assertEquals("", auth.credentialFor("https", "github.com", "owner/project\npassword=x"));
        auth.configure("Iv1.another-fixture"); assertEquals("idle", state()); assertFalse(preferences.contains("credential"));
        auth.close(); assertEquals("", auth.credentialFor("https", "github.com", ""));
        assertThrows(IOException.class, () -> auth.begin());
    }

    @Test public void networkExceptionsAndMalformedDeviceRedirectsRemainSafeAndDoNotPersist() throws Exception {
        auth.configure(CLIENT); network.add(request -> { throw new IOException("raw-secret=" + TOKEN); }); auth.begin(); scheduler.runNext();
        assertEquals("error", state()); assertFalse(auth.status().toString().contains(TOKEN));
        JSONObject malicious = obj("device_code", DEVICE, "user_code", "ABCD-EFGH", "verification_uri", "https://evil.test/login", "expires_in", 900);
        network.add(new GitHubAuth.Response(200, malicious)); auth.begin(); scheduler.runNext();
        assertEquals("error", state()); assertEquals("", auth.verificationUri()); assertFalse(preferences.contains("credential"));
    }

    private static final class FixtureCipher implements GitHubAuth.KeyCipher {
        private static final SecretKeySpec SECRET = new SecretKeySpec(new byte[16], "AES");
        public JSONObject seal(String text) throws Exception {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, SECRET);
            return obj("iv", Base64.getEncoder().encodeToString(cipher.getIV()), "ciphertext", Base64.getEncoder().encodeToString(cipher.doFinal(text.getBytes(StandardCharsets.UTF_8))));
        }
        public String open(JSONObject encrypted) throws Exception {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, SECRET, new GCMParameterSpec(128, Base64.getDecoder().decode(encrypted.getString("iv"))));
            return new String(cipher.doFinal(Base64.getDecoder().decode(encrypted.getString("ciphertext"))), StandardCharsets.UTF_8);
        }
    }
    private static final class FakeClock implements GitHubAuth.TimeSource {
        private long now = 1800000000000L, elapsed;
        public long nowMillis() { return now; } public long elapsedMillis() { return elapsed; }
        void advance(long millis) { now += millis; elapsed += millis; }
    }
    private static final class Request {
        final String method, url, token; final Map<String, String> form;
        Request(String method, String url, Map<String, String> form, String token) { this.method = method; this.url = url; this.form = form; this.token = token; }
    }
    private interface Responder { GitHubAuth.Response reply(Request request) throws IOException; }
    private static final class ScriptNetwork implements GitHubAuth.Network {
        final List<Request> requests = new ArrayList<>(); final ArrayDeque<Responder> responses = new ArrayDeque<>();
        void add(GitHubAuth.Response response) { responses.add(request -> response); }
        void add(Responder responder) { responses.add(responder); }
        public GitHubAuth.Response exchange(String method, String url, Map<String, String> form, String token) throws IOException {
            assertTrue(GitHubAuthPolicy.endpointAllowed(method, url));
            Request request = new Request(method, url, form, token); requests.add(request);
            if (responses.isEmpty()) throw new AssertionError("Unexpected GitHub request: " + url);
            return responses.remove().reply(request);
        }
    }
    /** Advances virtual time to each scheduled task, so five-second polling is tested without sleeping. */
    private static final class ManualScheduler extends AbstractExecutorService implements ScheduledExecutorService {
        private final FakeClock clock;
        private final PriorityQueue<Task> tasks = new PriorityQueue<>(Comparator.comparingLong((Task task) -> task.due).thenComparingLong(task -> task.sequence));
        private boolean shutdown; private long sequence;
        ManualScheduler(FakeClock clock) { this.clock = clock; }
        boolean hasTasks() { while (!tasks.isEmpty() && tasks.peek().cancelled) tasks.remove(); return !tasks.isEmpty(); }
        long nextDelay() { if (!hasTasks()) return -1; return Math.max(0, tasks.peek().due - clock.elapsedMillis()); }
        void runNext() {
            assertTrue("Expected a scheduled task", hasTasks()); Task task = tasks.remove();
            clock.advance(Math.max(0, task.due - clock.elapsedMillis())); task.action.run(); task.done = true;
        }
        public ScheduledFuture<?> schedule(Runnable runnable, long delay, TimeUnit unit) {
            if (shutdown) throw new java.util.concurrent.RejectedExecutionException();
            Task task = new Task(runnable, clock.elapsedMillis() + unit.toMillis(delay), sequence++); tasks.add(task); return task;
        }
        public <V> ScheduledFuture<V> schedule(Callable<V> callable, long delay, TimeUnit unit) { throw new UnsupportedOperationException(); }
        public ScheduledFuture<?> scheduleAtFixedRate(Runnable runnable, long initial, long period, TimeUnit unit) { throw new UnsupportedOperationException(); }
        public ScheduledFuture<?> scheduleWithFixedDelay(Runnable runnable, long initial, long delay, TimeUnit unit) { throw new UnsupportedOperationException(); }
        public void execute(Runnable runnable) { schedule(runnable, 0, TimeUnit.MILLISECONDS); }
        public void shutdown() { shutdown = true; }
        public List<Runnable> shutdownNow() { shutdown = true; tasks.clear(); return List.of(); }
        public boolean isShutdown() { return shutdown; } public boolean isTerminated() { return shutdown; }
        public boolean awaitTermination(long timeout, TimeUnit unit) { return shutdown; }
        private final class Task implements ScheduledFuture<Object> {
            final Runnable action; final long due, sequence; boolean cancelled, done;
            Task(Runnable action, long due, long sequence) { this.action = action; this.due = due; this.sequence = sequence; }
            public long getDelay(TimeUnit unit) { return unit.convert(due - clock.elapsedMillis(), TimeUnit.MILLISECONDS); }
            public int compareTo(Delayed other) { return Long.compare(getDelay(TimeUnit.MILLISECONDS), other.getDelay(TimeUnit.MILLISECONDS)); }
            public boolean cancel(boolean interrupt) { if (done) return false; cancelled = true; return true; }
            public boolean isCancelled() { return cancelled; } public boolean isDone() { return done || cancelled; }
            public Object get() { return null; } public Object get(long timeout, TimeUnit unit) { return null; }
        }
    }
}
