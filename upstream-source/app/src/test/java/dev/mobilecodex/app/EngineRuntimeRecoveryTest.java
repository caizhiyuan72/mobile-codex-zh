package dev.mobilecodex.app;

import android.app.Application;
import dev.mobilecodex.app.core.RpcClient;
import dev.mobilecodex.app.core.RuntimeFailure;
import java.io.*;
import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowBuild;
import static dev.mobilecodex.app.core.Json.*;
import static org.junit.Assert.*;

/** Reproduces a send queued ahead of the old transport's disconnect callback. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 29, application = Application.class)
public class EngineRuntimeRecoveryTest {
    private Engine engine;
    private JSONObject session;
    private android.content.SharedPreferences preferences;
    private File fixtureRoot;
    private static class Child extends Process {
        boolean alive;
        Child(boolean alive) { this.alive = alive; }
        public OutputStream getOutputStream() { return OutputStream.nullOutputStream(); }
        public InputStream getInputStream() { return InputStream.nullInputStream(); }
        public InputStream getErrorStream() { return InputStream.nullInputStream(); }
        public int waitFor() { return 0; }
        public int exitValue() { if (alive) throw new IllegalThreadStateException(); return 0; }
        public boolean isAlive() { return alive; }
        public void destroy() { alive = false; }
    }
    private Object field(String name) throws Exception {
        Field f = Engine.class.getDeclaredField(name); f.setAccessible(true); return f.get(engine);
    }
    private void field(String name, Object value) throws Exception {
        Field f = Engine.class.getDeclaredField(name); f.setAccessible(true); f.set(engine, value);
    }
    @Before public void setup() throws Exception {
        Application app = RuntimeEnvironment.getApplication();
        // A native Android executable is intentionally absent from this unit test.
        app.getApplicationInfo().nativeLibraryDir = new File(app.getCacheDir(), "missing-runtime-test").getAbsolutePath();
        ShadowBuild.setSupportedAbis(new String[]{"arm64-v8a"});
        app.getSharedPreferences("projects", 0).edit().clear().commit();
        app.getSharedPreferences("workspace", 0).edit().clear().commit();
        java.nio.file.Files.deleteIfExists(new File(app.getFilesDir(), "sessions.json").toPath());
        preferences = app.getSharedPreferences("runtime-recovery-providers", 0);
        preferences.edit().clear().commit();
        fixtureRoot = new File(app.getCacheDir(), "runtime-recovery-" + UUID.randomUUID());
        ApiProviders providers = new ApiProviders(preferences, new ApiProvidersTest.FixtureCipher(), new File(fixtureRoot, "runtime"));
        String provider = providers.save(obj("name", "Recovery fixture", "baseUrl", "https://example.test/v1",
            "models", "gpt-6-astra", "apiKey", "sk-fixture-never-a-real-key", "protocol", "responses")).getString("id");
        providers.select(provider);
        engine = new Engine(app, providers);
        session = obj("id", "local-saved", "sessionVersion", 2, "codexThreadId", "remote-saved",
            "title", "Keep this chat", "workspace", "", "workspaceKey", "", "model", "gpt-6-astra",
            "apiScope", providers.scope(),
            "imageHistoryVersion", 1, "workHistoryVersion", 1, "phoneToolsVersion", 1, "consultToolsVersion", 1,
            "messages", array(obj("id", "old-message", "role", "user", "text", "keep history")));
        field("sessions", array(session)); field("active", session); field("threadId", "local-saved");
        field("serverThreadId", "remote-saved"); field("ready", true);
    }
    @After public void cleanup() throws Exception {
        if (engine != null) {
            RpcClient rpc = (RpcClient) field("rpc"); if (rpc != null) rpc.close();
            engine.io.shutdownNow();
        }
        if (preferences != null) preferences.edit().clear().commit();
        if (fixtureRoot != null && fixtureRoot.exists()) try (java.util.stream.Stream<java.nio.file.Path> paths = java.nio.file.Files.walk(fixtureRoot.toPath())) {
            for (java.nio.file.Path path : paths.sorted(Comparator.reverseOrder()).collect(java.util.stream.Collectors.toList())) java.nio.file.Files.deleteIfExists(path);
        }
    }
    private RpcClient connection() {
        return new RpcClient(InputStream.nullInputStream(), OutputStream.nullOutputStream(), new RpcClient.Listener() {
            public void notification(String method, JSONObject params) {}
            public void request(Object id, String method, JSONObject params) {}
            public void disconnected(Throwable error) {}
        });
    }
    private void replaceUnavailableTransport(Child child, RpcClient rpc) throws Exception {
        field("process", child); field("rpc", rpc);
        // Exercise production replacement, not a reset helper. Stop at the absent native
        // binary in the test environment; transport cleanup happens before that check.
        Method start = Engine.class.getDeclaredMethod("start", boolean.class);
        start.setAccessible(true);
        try { start.invoke(engine, false); fail("No native runtime should launch in this test"); }
        catch (InvocationTargetException expected) { assertTrue(expected.getCause() instanceof IOException); }
        assertEquals("", field("serverThreadId"));
        assertEquals("local-saved", field("threadId"));
        assertSame(session, field("active"));
        assertEquals("keep history", session.getJSONArray("messages").getJSONObject(0).getString("text"));
    }
    @Test public void deadProcessInvalidatesLoadedThreadBeforeDelayedDisconnect() throws Exception {
        @SuppressWarnings("unchecked") Map<String,String> turns = (Map<String,String>)field("runningTurns");
        turns.put("local-saved", "obsolete-turn"); field("turnId", "obsolete-turn"); field("busy", true);
        Child old = new Child(false); RpcClient rpc = connection();
        replaceUnavailableTransport(old, rpc);
        assertTrue(turns.isEmpty()); assertFalse((Boolean)field("busy")); assertEquals("", field("turnId"));
        assertTrue(rpc.isClosed());
        Child replacement = new Child(true); field("process", replacement); field("ready", true);
        engine.codexDisconnected(old, rpc, null, new RuntimeFailure.Tail());
        assertSame(replacement, field("process")); assertTrue(replacement.alive);
    }
    @Test public void closedPipeOnLiveProcessAlsoInvalidatesLoadedThread() throws Exception {
        Child child = new Child(true); RpcClient rpc = connection(); rpc.close();
        replaceUnavailableTransport(child, rpc);
        assertFalse(child.alive);
    }
    @Test public void nextSendResumesSameThreadBeforeTurnAndKeepsHistory() throws Exception {
        session.put("conversationFailure", obj("code", "upstream_conflict", "turnId", "previous"));
        replaceUnavailableTransport(new Child(false), connection());
        List<String> calls = new ArrayList<>();
        engine.setTestTransport((method, params) -> {
            calls.add(method);
            if (method.equals("thread/resume")) {
                assertEquals("remote-saved", params.getString("threadId")); return obj();
            }
            if (method.equals("turn/start")) {
                assertEquals(List.of("thread/resume", "turn/start"), calls);
                assertEquals("remote-saved", params.getString("threadId")); return obj("turn", obj("id", "new-turn"));
            }
            throw new AssertionError("Unexpected RPC: " + method);
        });
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        engine.handle("chat.send", obj("text", "continue", "model", "gpt-6-astra"), (r,e) -> {
            if (e == null) result.complete(r); else result.completeExceptionally(e);
        });
        result.get(10, TimeUnit.SECONDS);
        assertEquals(List.of("thread/resume", "turn/start"), calls);
        assertEquals("remote-saved", field("serverThreadId"));
        assertEquals(2, session.getJSONArray("messages").length());
        assertEquals("keep history", session.getJSONArray("messages").getJSONObject(0).getString("text"));
        assertEquals(1, ((JSONArray)field("sessions")).length());
        assertFalse(session.has("conversationFailure"));
    }
    @Test public void healthyTransportDoesNotDiscardLoadedThreadOrRunningTurn() throws Exception {
        Child child = new Child(true); RpcClient rpc = connection();
        field("process", child); field("rpc", rpc);
        @SuppressWarnings("unchecked") Map<String,String> turns = (Map<String,String>)field("runningTurns");
        turns.put("local-saved", "still-running");
        Method start = Engine.class.getDeclaredMethod("start", boolean.class); start.setAccessible(true);
        start.invoke(engine, false);
        assertEquals("remote-saved", field("serverThreadId"));
        assertEquals("still-running", turns.get("local-saved"));
        assertSame(child, field("process")); assertFalse(rpc.isClosed());
    }
    @Test public void foregroundReconnectsOnlyTheRememberedProviderAndNeverResends() throws Exception {
        List<String> calls = new ArrayList<>();
        engine.setTestTransport((method, params) -> { calls.add(method); return obj(); });
        Engine.Ui owner = new Engine.Ui() {
            public void event(String name, JSONObject data) { }
            public void approval(Engine.Approval approval) { }
        };
        field("ready", false); field("serverThreadId", "");
        var recovery = RuntimeEnvironment.getApplication().getSharedPreferences("runtime-recovery", 0);
        recovery.edit().putString("scope", "other-provider").commit();
        engine.resumeForeground(owner); engine.io.submit(() -> {}).get(5, TimeUnit.SECONDS);
        assertFalse((boolean)field("ready")); assertTrue(calls.isEmpty());
        recovery.edit().putString("scope", session.getString("apiScope")).commit();
        engine.resumeForeground(owner); engine.io.submit(() -> {}).get(5, TimeUnit.SECONDS);
        engine.resumeForeground(owner); engine.io.submit(() -> {}).get(5, TimeUnit.SECONDS);
        assertEquals(List.of("thread/resume"), calls);
        engine.stop(); engine.io.submit(() -> {}).get(5, TimeUnit.SECONDS);
        engine.resumeForeground(owner); engine.io.submit(() -> {}).get(5, TimeUnit.SECONDS);
        assertFalse((boolean)field("ready")); assertEquals(List.of("thread/resume"), calls);
    }

    @Test public void backgroundEofConsumesOneRecoveryWithoutStartingAnotherTurn() throws Exception {
        var recovery = RuntimeEnvironment.getApplication().getSharedPreferences("runtime-recovery", 0);
        recovery.edit().putString("scope", session.getString("apiScope")).commit();
        Method track = Engine.class.getDeclaredMethod("trackTurn", String.class, String.class, long.class);
        track.setAccessible(true);
        track.invoke(engine, "local-saved", "interrupted-turn", 1L);
        assertEquals(session.getString("apiScope"), recovery.getString("backgroundScope", ""));
        List<String> calls = new ArrayList<>();
        engine.setTestTransport((method, params) -> { calls.add(method); return obj(); });
        Child child = new Child(false); field("process", child);
        engine.io.submit(() -> engine.codexDisconnected(child, null, null, new RuntimeFailure.Tail())).get(5, TimeUnit.SECONDS);
        assertEquals(List.of("thread/resume"), calls);
        assertTrue((boolean)field("ready"));
        assertFalse(recovery.contains("backgroundScope"));
        assertEquals("runtime_disconnected", session.getJSONObject("conversationFailure").getString("code"));
        field("ready", false);
        engine.reconcileService(); engine.io.submit(() -> {}).get(5, TimeUnit.SECONDS);
        assertFalse((boolean)field("ready")); assertEquals(List.of("thread/resume"), calls);
    }

    @Test public void recreatedServiceRecoversOnlyAnActiveMatchingProviderBeforeUiReturns() throws Exception {
        var app = RuntimeEnvironment.getApplication();
        var recovery = app.getSharedPreferences("runtime-recovery", 0);
        String scope = session.getString("apiScope");
        session.put("inFlightTurn", "lost");
        ((dev.mobilecodex.app.core.SessionStore)field("sessionStore")).save(array(session));
        Engine recreated = new Engine(app, (ApiProviders)field("apiProviders"));
        List<String> calls = new ArrayList<>();
        recreated.setTestTransport((method, params) -> { calls.add(method); return obj(); });
        try {
            recovery.edit().putString("scope", scope).putString("backgroundScope", "other").commit();
            recreated.reconcileService(); recreated.io.submit(() -> {}).get(5, TimeUnit.SECONDS);
            assertFalse(recreated.hasForegroundWork());
            recovery.edit().putString("backgroundScope", scope).commit();
            recreated.reconcileService(); recreated.io.submit(() -> {}).get(5, TimeUnit.SECONDS);
            assertFalse(recreated.hasForegroundWork());
            recreated.restoreVisibleThread("local-saved");
            recreated.io.submit(() -> {}).get(5, TimeUnit.SECONDS);
            assertEquals("local-saved", recreated.visibleThreadId());
            assertTrue(calls.isEmpty());
            recreated.stop(); recreated.io.submit(() -> {}).get(5, TimeUnit.SECONDS);
            recreated.reconcileService(); recreated.io.submit(() -> {}).get(5, TimeUnit.SECONDS);
            assertFalse(recreated.hasForegroundWork());
        } finally { recreated.io.shutdownNow(); }
    }
}
