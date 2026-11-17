package dev.mobilecodex.app;

import android.content.Context;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.*;
import static dev.mobilecodex.app.core.Json.obj;

/** Gives Git a short-lived local capability instead of putting an OAuth token in its environment. */
final class GitHubCredentials implements AutoCloseable {
    interface Source { String credentialFor(String protocol, String host, String path) throws IOException; }
    private static final int LIMIT = 8192;
    private final Source source;
    private final File helper;
    private final byte[] helperBytes;
    private final String capability;
    private ServerSocket server;
    private boolean closed;

    GitHubCredentials(Context context, Source source) {
        this.source = source;
        helper = new File(context.getFilesDir(), "github/git-credential-mobile.py");
        byte[] bytes;
        try (InputStream in = context.getAssets().open("git-credential-mobile.py")) {
            ByteArrayOutputStream data = new ByteArrayOutputStream();
            byte[] block = new byte[8192]; int n;
            while ((n = in.read(block)) != -1) data.write(block, 0, n);
            bytes = data.toByteArray();
        }
        catch (IOException error) { bytes = null; }
        helperBytes = bytes;
        byte[] random = new byte[32]; new SecureRandom().nextBytes(random);
        capability = Base64.getUrlEncoder().withoutPadding().encodeToString(random);
    }
    GitHubCredentials(File helper, Source source, String capability) {
        this.source = source; this.helper = helper; this.capability = capability; helperBytes = null;
    }
    synchronized void configure(Map<String, String> env) throws IOException {
        if (closed) throw new IOException("GitHub 凭据服务已关闭。");
        if (helperBytes != null) {
            Files.createDirectories(helper.toPath().getParent());
            if (!helper.isFile() || !Arrays.equals(Files.readAllBytes(helper.toPath()), helperBytes))
                Files.write(helper.toPath(), helperBytes);
        } else if (!helper.isFile()) throw new IOException("GitHub 登录组件缺失，请安装完整 APK。");
        if (server == null) {
            server = new ServerSocket();
            server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 4);
            Thread worker = new Thread(this::serve, "github-git-credentials");
            worker.setDaemon(true); worker.start();
        }
        configureEnvironment(env, server.getLocalPort(), capability, helper);
    }
    static void configureEnvironment(Map<String, String> env, int port, String capability, File helper) throws IOException {
        int count;
        try { count = Integer.parseInt(env.getOrDefault("GIT_CONFIG_COUNT", "0")); }
        catch (NumberFormatException error) { throw new IOException("Git 配置环境无效。"); }
        if (count < 0 || count > 64) throw new IOException("Git 配置环境无效。");
        env.put("MC_GITHUB_PORT", Integer.toString(port));
        env.put("MC_GITHUB_CAPABILITY", capability);
        env.put("MC_GITHUB_HELPER", helper.getAbsolutePath());
        // Reset helpers for this host so an earlier helper cannot persist this token.
        env.put("GIT_CONFIG_KEY_" + count, "credential.https://github.com.helper");
        env.put("GIT_CONFIG_VALUE_" + count++, "");
        env.put("GIT_CONFIG_KEY_" + count, "credential.https://github.com.helper");
        env.put("GIT_CONFIG_VALUE_" + count++, "!\"$MC_PYTHON\" \"$MC_GITHUB_HELPER\"");
        env.put("GIT_CONFIG_COUNT", Integer.toString(count));
        env.put("GIT_TERMINAL_PROMPT", "0");
    }
    private void serve() {
        ServerSocket listener;
        synchronized (this) { listener = server; }
        while (!listener.isClosed()) {
            try (Socket client = listener.accept()) {
                client.setSoTimeout(3000);
                JSONObject answer = obj();
                try {
                    JSONObject request = new JSONObject(readLine(client.getInputStream()));
                    byte[] expected = capability.getBytes(StandardCharsets.UTF_8);
                    byte[] supplied = request.optString("capability").getBytes(StandardCharsets.UTF_8);
                    if (MessageDigest.isEqual(expected, supplied)) {
                        String token = source.credentialFor(request.optString("protocol"), request.optString("host"), request.optString("path"));
                        if (!token.isBlank()) answer = obj("username", "x-access-token", "password", token);
                    }
                } catch (Exception ignored) { /* Never copy a secret or a request into error output. */ }
                client.getOutputStream().write((answer.toString() + "\n").getBytes(StandardCharsets.UTF_8));
            } catch (IOException ignored) { /* A closed client must not stop later Git requests. */ }
        }
    }
    static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        for (int n; (n = in.read()) != -1 && n != '\n'; ) {
            if (bytes.size() >= LIMIT || n == 0) throw new IOException("Invalid Git credential request");
            bytes.write(n);
        }
        return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
    }
    @Override public synchronized void close() {
        closed = true;
        if (server != null) try { server.close(); } catch (IOException ignored) { }
    }
}
