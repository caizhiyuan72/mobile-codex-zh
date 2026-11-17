package dev.mobilecodex.app;

import org.json.JSONObject;
import org.junit.Test;
import java.io.*;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

public class GitHubCredentialsTest {
    @Test public void processReceivesCapabilityButNeverAnOAuthToken() throws Exception {
        Map<String, String> env = new HashMap<>();
        env.put("GIT_CONFIG_COUNT", "1"); env.put("GIT_CONFIG_KEY_0", "existing.setting"); env.put("GIT_CONFIG_VALUE_0", "existing-value");
        GitHubCredentials.configureEnvironment(env, 12345, "fixture-capability", new File("/app/github/helper.py"));
        assertEquals("3", env.get("GIT_CONFIG_COUNT"));
        assertEquals("existing-value", env.get("GIT_CONFIG_VALUE_0"));
        assertEquals("credential.https://github.com.helper", env.get("GIT_CONFIG_KEY_1"));
        assertEquals("", env.get("GIT_CONFIG_VALUE_1"));
        assertEquals("!\"$MC_PYTHON\" \"$MC_GITHUB_HELPER\"", env.get("GIT_CONFIG_VALUE_2"));
        assertFalse(env.toString().contains("password"));
    }
    @Test public void brokerRejectsWrongCapabilityAndDoesNotCacheCredentials() throws Exception {
        File helper = File.createTempFile("github-helper", ".py");
        AtomicInteger calls = new AtomicInteger();
        try (GitHubCredentials broker = new GitHubCredentials(helper, (protocol, host, path) -> {
            calls.incrementAndGet(); return calls.get() == 1 ? "fixture-token" : "";
        }, "fixture-capability")) {
            Map<String, String> env = new HashMap<>(); broker.configure(env);
            int port = Integer.parseInt(env.get("MC_GITHUB_PORT"));
            assertEquals(0, request(port, "wrong").length()); assertEquals(0, calls.get());
            assertEquals("fixture-token", request(port, "fixture-capability").getString("password"));
            assertEquals(0, request(port, "fixture-capability").length());
            assertEquals(2, calls.get());
        } finally { helper.delete(); }
    }
    @Test public void requestsHaveBoundedInputAndConfigCount() throws Exception {
        try { GitHubCredentials.readLine(new ByteArrayInputStream(new byte[]{0})); fail("NUL accepted"); }
        catch (IOException expected) { }
        byte[] longLine = new byte[9000]; Arrays.fill(longLine, (byte) 'a');
        try { GitHubCredentials.readLine(new ByteArrayInputStream(longLine)); fail("Oversized request accepted"); }
        catch (IOException expected) { }
        for (String value : List.of("-1", "65", "invalid")) {
            try { GitHubCredentials.configureEnvironment(new HashMap<>(Map.of("GIT_CONFIG_COUNT", value)), 1, "fixture", new File("helper.py")); fail("Invalid count accepted"); }
            catch (IOException expected) { }
        }
    }
    private static JSONObject request(int port, String capability) throws Exception {
        try (Socket socket = new Socket("127.0.0.1", port)) {
            socket.setSoTimeout(3000);
            String request = new JSONObject().put("capability", capability).put("protocol", "https").put("host", "github.com").toString();
            socket.getOutputStream().write((request + "\n").getBytes(StandardCharsets.UTF_8));
            return new JSONObject(GitHubCredentials.readLine(socket.getInputStream()));
        }
    }
}
