package dev.mobilecodex.app;

import android.app.Application;
import dev.mobilecodex.app.core.Texts;
import org.json.JSONObject;
import org.json.JSONException;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowEnvironment;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import static dev.mobilecodex.app.core.Json.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 32, application = Application.class)
public class EngineActivityEventTest {
    private Engine engine;
    private final List<JSONObject> activity = new ArrayList<>();

    @Before public void before() throws Exception {
        Texts.configure(Map.of());
        Application application = RuntimeEnvironment.getApplication();
        ShadowEnvironment.addExternalDir("engine-activity-events");
        engine = new Engine(application);
        JSONObject current = obj("id", "current-local", "sessionVersion", 2,
            "codexThreadId", "current-remote", "workspaceKey", "", "messages", array());
        JSONObject background = obj("id", "background-local", "sessionVersion", 2,
            "codexThreadId", "background-remote", "workspaceKey", "", "messages", array());
        set("sessions", array(current, background));
        set("active", current);
        set("threadId", "current-local");
        engine.attach(new Engine.Ui() {
            @Override public void event(String name, JSONObject data) {
                if ("agent.event".equals(name)) {
                    try { activity.add(new JSONObject(data.toString())); }
                    catch (JSONException error) { throw new AssertionError(error); }
                }
            }
            @Override public void approval(Engine.Approval approval) { }
        });
        CompletableFuture<JSONObject> snapshot = new CompletableFuture<>();
        engine.handle("state", obj(), (value, error) -> {
            if (error == null) snapshot.complete(value); else snapshot.completeExceptionally(error);
        });
        snapshot.get(5, TimeUnit.SECONDS);
    }

    @After public void after() throws Exception {
        engine.io.shutdownNow();
        ((ScheduledExecutorService) get("approvalTimer")).shutdownNow();
        Texts.configure(Map.of());
    }

    @Test public void currentCommandOutputCarriesTheLocalThreadId() throws Exception {
        notifyEvent("item/commandExecution/outputDelta", obj("threadId", "current-remote",
            "itemId", "command", "delta", "current output"));
        assertEquals(1, activity.size());
        assertEquals("current-local", activity.get(0).getString("threadId"));
        assertEquals("current output", activity.get(0).getJSONObject("params").getString("delta"));
    }

    @Test public void backgroundAndUnknownActivityCannotReachTheCurrentConversation() throws Exception {
        for (String remoteThread : List.of("background-remote", "unknown-child")) {
            notifyEvent("item/commandExecution/outputDelta", obj("threadId", remoteThread,
                "itemId", "command", "delta", "unrelated output"));
            notifyEvent("item/reasoning/textDelta", obj("threadId", remoteThread,
                "itemId", "reasoning", "delta", "unrelated reasoning"));
            notifyEvent("item/started", obj("threadId", remoteThread,
                "item", obj("id", "command", "type", "commandExecution", "command", "unrelated command")));
        }
        assertTrue(activity.isEmpty());
    }

    @Test public void trackedOutputRecoversMissingStartAndStreamsLaterDeltasInPlace() throws Exception {
        @SuppressWarnings("unchecked") Map<String,String> running = (Map<String,String>) get("runningTurns");
        running.put("current-local", "turn");
        TurnProgress progress = trackProgress("turn");
        JSONObject active = (JSONObject) get("active");
        active.getJSONArray("messages").put(obj("id", "intro", "role", "assistant", "text", "Checking"));
        JSONObject delta = obj("threadId", "current-remote", "turnId", "turn", "itemId", "command", "delta", "first");
        notifyEvent("item/commandExecution/outputDelta", delta);
        assertTrue(progress.snapshot(0).getLong("lastVisibleAt") > 1);
        progress.visibleActivity(2);
        notifyEvent("item/commandExecution/outputDelta", delta.put("delta", " second"));
        notifyEvent("item/completed", obj("threadId", "current-remote", "turnId", "turn", "item",
            obj("id", "command", "type", "commandExecution", "command", "pwd")));
        notifyEvent("item/commandExecution/outputDelta", delta.put("delta", " late"));
        assertEquals(2L, progress.snapshot(0).getLong("lastVisibleAt"));
        var messages = active.getJSONArray("messages");
        assertEquals(2, messages.length());
        assertEquals("intro", messages.getJSONObject(0).getString("id"));
        assertEquals("pwd", messages.getJSONObject(1).getString("detail"));
        assertEquals("first second", messages.getJSONObject(1).getString("output"));
        assertEquals(1, activity.size());
        assertEquals(" second", activity.get(0).getJSONObject("params").getString("delta"));
    }

    @Test public void legacyImplicitCurrentThreadStillHasALocalScope() throws Exception {
        notifyEvent("item/commandExecution/outputDelta", obj("itemId", "command", "delta", "legacy output"));
        assertEquals(1, activity.size());
        assertEquals("current-local", activity.get(0).getString("threadId"));
    }

    @Test public void reasoningOnlyExposesStatusAndTimestamps() throws Exception {
        TurnProgress current = trackProgress("one");
        JSONObject part = obj("threadId", "current-remote", "turnId", "one", "itemId", "r", "summaryIndex", 0);
        notifyEvent("item/reasoning/summaryTextDelta", part.put("delta", "Public progress"));
        JSONObject progress = current.snapshot(9);
        notifyEvent("item/reasoning/textDelta", part.put("delta", "private"));
        notifyEvent("item/reasoning/summaryTextDelta", part.put("turnId", "expired"));
        notifyEvent("item/reasoning/summaryTextDelta", part.put("turnId", "one").put("threadId", "background-remote"));
        assertEquals("reasoning", progress.getString("phase"));
        assertEquals(1L, progress.getLong("lastVisibleAt"));
        assertEquals(progress.getLong("lastEventAt"), current.snapshot(9).getLong("lastEventAt"));
        assertFalse(progress.has("summary"));
        notifyEvent("item/completed", obj("threadId", "current-remote", "turnId", "one", "item",
            obj("id", "r", "type", "reasoning", "summary", array("Public result"), "content", array("private"), "encrypted_content", "opaque")));
        assertFalse(current.snapshot(9).has("summary"));
        assertEquals("waiting", current.snapshot(9).getString("phase"));
        assertEquals(1L, current.snapshot(9).getLong("lastVisibleAt"));
        assertEquals(9L, current.snapshot(9).getLong("engineReplyAt"));
        assertTrue(activity.isEmpty());
    }

    @Test public void onlyVisibleReplyTextAndNewShellCommandsResetTheTimer() throws Exception {
        @SuppressWarnings("unchecked") Map<String,String> running = (Map<String,String>) get("runningTurns");
        running.put("current-local", "turn");
        TurnProgress progress = trackProgress("turn");
        JSONObject text = obj("threadId", "current-remote", "turnId", "turn", "itemId", "reply", "delta", " \n");
        notifyEvent("item/agentMessage/delta", text);
        assertEquals(1L, progress.snapshot(0).getLong("lastVisibleAt"));
        notifyEvent("item/agentMessage/delta", text.put("delta", "Checking"));
        assertTrue(progress.snapshot(0).getLong("lastVisibleAt") > 1);
        progress.visibleActivity(2);
        notifyEvent("item/completed", obj("threadId", "current-remote", "turnId", "turn", "item",
            obj("id", "reply", "type", "agentMessage", "text", " \nChecking")));
        assertEquals(2L, progress.snapshot(0).getLong("lastVisibleAt"));
        JSONObject command = obj("threadId", "current-remote", "turnId", "turn", "item",
            obj("id", "command", "type", "commandExecution", "command", "pwd"));
        notifyEvent("item/started", command);
        assertTrue(progress.snapshot(0).getLong("lastVisibleAt") > 2);
        progress.visibleActivity(3);
        notifyEvent("item/started", command);
        notifyEvent("item/completed", command);
        assertEquals(3L, progress.snapshot(0).getLong("lastVisibleAt"));
    }

    private TurnProgress trackProgress(String turn) throws Exception {
        TurnProgress progress = new TurnProgress(turn, 1);
        @SuppressWarnings("unchecked") Map<String,TurnProgress> tracked = (Map<String,TurnProgress>) get("turnProgress");
        tracked.put("current-local", progress);
        return progress;
    }

    private void notifyEvent(String name, JSONObject params) throws Exception {
        Method notification = Engine.class.getDeclaredMethod("onNotification", String.class, JSONObject.class);
        notification.setAccessible(true);
        engine.io.submit(() -> { notification.invoke(engine, name, params); return null; }).get(5, TimeUnit.SECONDS);
    }

    private Object get(String name) throws Exception {
        Field field = Engine.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(engine);
    }

    private void set(String name, Object value) throws Exception {
        Field field = Engine.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(engine, value);
    }
}
