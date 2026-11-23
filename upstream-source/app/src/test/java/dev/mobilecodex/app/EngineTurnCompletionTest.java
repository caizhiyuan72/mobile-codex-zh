package dev.mobilecodex.app;

import android.app.Application;
import android.content.Intent;
import dev.mobilecodex.app.core.Texts;
import dev.mobilecodex.app.core.ConversationFailure;
import dev.mobilecodex.app.core.Utf8Files;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowEnvironment;

import java.io.File;
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
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 32, application = Application.class)
public class EngineTurnCompletionTest {
    private Application application;
    private Engine engine;
    private JSONObject session;
    private JSONObject state;
    private final List<JSONObject> errors = new ArrayList<>();

    @Before public void before() throws Exception {
        Texts.configure(Map.of());
        application = RuntimeEnvironment.getApplication();
        // API 32's isExternalStorageManager() reads the first external volume.
        // Robolectric starts with none; provide one so Engine can publish state.
        ShadowEnvironment.addExternalDir("engine-turn-completion");
        application.getSharedPreferences("notifications", 0).edit().putBoolean("enabled", false).commit();
        engine = new Engine(application);
        session = obj("id", "local-thread", "sessionVersion", 2, "codexThreadId", "remote-thread",
            "workspaceKey", "", "messages", array(), "approvalPending", true);
        set("sessions", array(session));
        set("active", session);
        set("threadId", "local-thread");
        set("turnId", "turn-one");
        set("ready", true);
        set("busy", true);
        runningTurns().put("local-thread", "turn-one");
        engine.attach(new Engine.Ui() {
            @Override public void event(String name, JSONObject data) {
                if ("state".equals(name)) state = data;
                if ("error".equals(name)) errors.add(data);
            }
            @Override public void approval(Engine.Approval approval) { }
        });
        CompletableFuture<JSONObject> snapshot = new CompletableFuture<>();
        engine.handle("state", obj(), (value, error) -> {
            if (error == null) snapshot.complete(value); else snapshot.completeExceptionally(error);
        });
        assertTrue(snapshot.get(5, TimeUnit.SECONDS).getBoolean("busy"));
        assertNotNull("Attached UI must receive the initial state", state);
    }

    @After public void after() throws Exception {
        engine.io.shutdownNow();
        ((ScheduledExecutorService) get("approvalTimer")).shutdownNow();
        Texts.configure(Map.of());
    }

    @Test public void interruptedTurnReportsStoppedAndPersistsStoppedImageReason() throws Exception {
        session.getJSONArray("messages").put(obj("id", "image-one", "role", "assistant", "kind", "image",
            "imageGroup", "turn-one", "imageStatus", "generating"));

        complete(obj("id", "turn-one", "status", "interrupted", "error", JSONObject.NULL));

        Intent notification = lastTaskNotification();
        assertEquals("interrupted", notification.getStringExtra("kind"));
        assertEquals("任务已停止", notification.getStringExtra("title"));
        assertEquals("Codex 任务已停止。", notification.getStringExtra("message"));
        assertEquals("local-thread", notification.getStringExtra("threadId"));
        assertFalse(state.getBoolean("busy"));
        assertEquals("任务已停止", state.getString("status"));
        assertFalse(session.getBoolean("approvalPending"));
        assertTrue(errors.isEmpty());
        JSONArray saved = new JSONArray(Utf8Files.read(new File(application.getFilesDir(), "sessions.json").toPath()));
        JSONObject image = saved.getJSONObject(0).getJSONArray("messages").getJSONObject(0);
        assertEquals("failed", image.getString("imageStatus"));
        assertEquals("任务已停止，图片生成未能完成。", image.getString("imageError"));
    }

    @Test public void completedTurnRetainsSuccessfulNotification() throws Exception {
        notifyEvent("item/completed", obj("threadId", "remote-thread", "turnId", "turn-one",
            "item", obj("id", "answer", "type", "agentMessage", "text", "Exported report.pdf.")));
        complete(obj("id", "turn-one", "status", "completed", "error", JSONObject.NULL));

        Intent notification = lastTaskNotification();
        assertEquals("completed", notification.getStringExtra("kind"));
        assertEquals("回答完成", notification.getStringExtra("title"));
        assertEquals("Codex 已完成任务。", notification.getStringExtra("message"));
        assertFalse(state.getBoolean("busy"));
        assertEquals(1, state.getJSONArray("messages").length());
        assertEquals("Exported report.pdf.", state.getJSONArray("messages").getJSONObject(0).getString("text"));
        assertTrue(errors.isEmpty());
    }

    @Test public void completionWithoutFinalReplyPersistsAnAppNotice() throws Exception {
        session.getJSONArray("messages").put(obj("id", "earlier-answer", "role", "assistant",
            "text", "Earlier reply", "completedTurnId", "earlier-turn"));
        notifyEvent("item/completed", obj("threadId", "remote-thread", "turnId", "turn-one",
            "item", obj("id", "progress", "type", "agentMessage", "phase", "commentary", "text", "Checking files.")));

        complete(obj("id", "turn-one", "status", "completed"));

        assertEquals("任务已结束", lastTaskNotification().getStringExtra("title"));
        assertFalse(state.getBoolean("busy"));
        assertEquals("completionNotice", state.getJSONArray("messages").getJSONObject(2).getString("kind"));
        JSONArray saved = new JSONArray(Utf8Files.read(new File(application.getFilesDir(), "sessions.json").toPath()));
        assertEquals("应用提示：任务已结束，但没有收到最终回复。",
            saved.getJSONObject(0).getJSONArray("messages").getJSONObject(2).getString("text"));
    }

    @Test public void completionMergesFinalReplyFromTurnItemsWithoutDuplicatingTheStream() throws Exception {
        notifyEvent("item/agentMessage/delta", obj("threadId", "remote-thread", "turnId", "turn-one",
            "itemId", "answer", "delta", "Saved"));

        complete(obj("id", "turn-one", "status", "completed", "items", array(
            obj("id", "progress", "type", "agentMessage", "phase", "commentary", "text", "Checking files."),
            obj("id", "answer", "type", "agentMessage", "phase", "final_answer", "text", "Saved report.pdf."))));

        assertEquals("回答完成", lastTaskNotification().getStringExtra("title"));
        JSONArray messages = state.getJSONArray("messages");
        assertEquals(1, messages.length());
        assertEquals("Saved report.pdf.", messages.getJSONObject(0).getString("text"));
    }

    @Test public void failedTurnWithoutErrorObjectStillReportsFailure() throws Exception {
        complete(obj("id", "turn-one", "status", "failed", "error", JSONObject.NULL));

        assertEquals("failed", lastTaskNotification().getStringExtra("kind"));
        assertEquals("任务失败", lastTaskNotification().getStringExtra("title"));
        assertEquals("任务失败", state.getString("status"));
        assertEquals(1, errors.size());
        assertEquals(ConversationFailure.message("turn_failed"), errors.get(0).getString("message"));
        assertEquals("turn_failed", state.getJSONObject("conversationFailure").getString("code"));
    }

    @Test public void failureDetailsRemainVisibleAndLegacyCompletionStillWorks() throws Exception {
        complete(obj("id", "turn-one", "error", obj("message", "Usage limit reached")));
        assertEquals("failed", lastTaskNotification().getStringExtra("kind"));
        assertEquals(ConversationFailure.message("turn_failed"), errors.get(0).getString("message"));

        runningTurns().put("local-thread", "turn-two");
        complete(obj("id", "turn-two"));
        assertEquals("completed", lastTaskNotification().getStringExtra("kind"));
        assertFalse(session.has("conversationFailure"));
        assertTrue(state.isNull("conversationFailure"));
    }

    @Test public void transportConflictPersistsOnlyFixedCodeAndKeepsOriginalThreadAndHistory() throws Exception {
        session.getJSONArray("messages").put(obj("id", "old", "role", "user", "text", "Keep task progress"));
        complete(obj("id", "turn-one", "status", "failed", "error", transportConflict()));

        assertEquals("local-thread", state.getString("threadId"));
        assertEquals("remote-thread", session.getString("codexThreadId"));
        assertFalse(state.getBoolean("busy"));
        JSONObject failure = state.getJSONObject("conversationFailure");
        assertEquals("encrypted_transport_changed", failure.getString("code"));
        assertEquals("turn-one", failure.getString("turnId"));
        assertEquals(2, failure.length());
        assertEquals(ConversationFailure.message("encrypted_transport_changed"), errors.get(0).getString("message"));
        String stored = Utf8Files.read(new File(application.getFilesDir(), "sessions.json").toPath());
        assertTrue(stored.contains("encrypted_transport_changed"));
        assertTrue(stored.contains("Keep task progress"));
        assertFalse(stored.contains("fixture-secret"));
        assertFalse(errors.toString().contains("fixture-secret"));
    }

    @Test public void retriedStreamErrorDoesNotFinishOrMarkTheTaskFailed() throws Exception {
        notifyEvent("error", obj("threadId", "remote-thread", "turnId", "turn-one", "willRetry", true,
            "error", transportConflict()));
        assertEquals("turn-one", runningTurns().get("local-thread"));
        assertFalse(session.has("conversationFailure"));
        assertTrue(errors.isEmpty());
        assertEquals(0, taskNotificationCount());
        complete(obj("id", "turn-one", "status", "completed"));
        assertTrue(state.isNull("conversationFailure"));
    }

    @Test public void failedBackgroundTurnAndStrayCompletionsCannotReplaceVisibleFailure() throws Exception {
        JSONObject background = obj("id", "background-local", "sessionVersion", 2,
            "codexThreadId", "background-remote", "messages", array());
        set("sessions", array(session, background));
        runningTurns().put("background-local", "background-turn");
        notifyCompletion("background-remote", obj("id", "background-turn", "status", "failed", "error", transportConflict()));
        assertEquals("encrypted_transport_changed", background.getJSONObject("conversationFailure").getString("code"));
        assertTrue(state.isNull("conversationFailure"));
        assertTrue(state.getBoolean("busy"));
        assertEquals("background-local", errors.get(0).getString("threadId"));
        notifyEvent("turn/completed", obj("threadId", "remote-thread", "turn", obj("id", "obsolete", "status", "failed", "error", transportConflict())));
        assertFalse(session.has("conversationFailure"));
        assertEquals("turn-one", runningTurns().get("local-thread"));
    }

    @Test public void cpuAndSubagentsSurviveDetachmentUntilLastTurnFinishes() throws Exception {
        notifyEvent("turn/started", obj("threadId", "remote-thread", "turn", obj("id", "turn-one")));
        android.os.PowerManager.WakeLock cpu = (android.os.PowerManager.WakeLock)get("taskCpu");
        assertTrue(cpu.isHeld());
        engine.detach((Engine.Ui)get("ui"));
        cpu.release();
        shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMinutes(5));
        assertTrue("Quiet turns renew the lease with no UI or progress events", cpu.isHeld());
        JSONObject spawn = obj("threadId", "remote-thread", "turnId", "turn-one", "item", obj("id", "spawn", "type", "collabAgentToolCall",
            "senderThreadId", "remote-thread", "status", "completed", "tool", "spawnAgent", "receiverThreadIds", array("child", "child-two")));
        notifyEvent("item/completed", spawn); notifyEvent("item/completed", spawn);
        notifyEvent("turn/completed", obj("threadId", "child", "turn", obj("id", "child-turn", "status", "completed")));
        CompletableFuture<JSONObject> restored = new CompletableFuture<>();
        engine.handle("state", obj(), (value,error) -> restored.complete(value));
        JSONObject usage = restored.get(5, TimeUnit.SECONDS).getJSONObject("subagentUsage");
        assertEquals(2, usage.getInt("total")); assertEquals(1, usage.getInt("running"));
        assertTrue(cpu.isHeld());
        JSONObject background = obj("id", "bg", "sessionVersion", 2, "codexThreadId", "bg-remote", "messages", array());
        set("sessions", array(session, background));
        notifyEvent("turn/started", obj("threadId", "bg-remote", "turn", obj("id", "bg-turn")));
        notifyEvent("turn/completed", obj("threadId", "remote-thread", "turn", obj("id", "turn-one", "status", "interrupted")));
        assertTrue(cpu.isHeld()); assertEquals(2, session.getJSONObject("subagentUsage").getInt("total"));
        notifyEvent("turn/completed", obj("threadId", "bg-remote", "turn", obj("id", "bg-turn", "status", "completed")));
        shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMinutes(5));
        assertFalse(cpu.isHeld());
    }

    private JSONObject transportConflict() {
        return obj("message", "HTTP 409: The proven encrypted agent transport changed. fixture-secret",
            "codexErrorInfo", obj("httpConnectionFailed", obj("httpStatusCode", 409)));
    }

    @Test public void interruptedBackgroundTurnLeavesVisibleTaskRunning() throws Exception {
        JSONObject background = obj("id", "background-local", "sessionVersion", 2,
            "codexThreadId", "background-remote", "messages", array(), "approvalPending", true);
        set("sessions", array(session, background));
        runningTurns().put("background-local", "background-turn");

        notifyCompletion("background-remote", obj("id", "background-turn", "status", "interrupted"));

        assertEquals("background-local", lastTaskNotification().getStringExtra("threadId"));
        assertEquals("interrupted", lastTaskNotification().getStringExtra("kind"));
        assertTrue(state.getBoolean("busy"));
        assertEquals("正在工作", state.getString("status"));
        assertEquals("turn-one", state.getString("turnId"));
        assertFalse(background.getBoolean("approvalPending"));
        assertTrue(session.getBoolean("approvalPending"));
        assertTrue(errors.isEmpty());
    }

    @Test public void commentaryAndToolItemsDoNotCompleteTheTask() throws Exception {
        notifyEvent("item/completed", obj("threadId", "remote-thread", "turnId", "turn-one",
            "item", obj("id", "progress", "type", "agentMessage", "phase", "commentary", "text", "I will inspect the files.")));
        assertTrue(runningTurns().containsKey("local-thread"));
        assertEquals(0, taskNotificationCount());
        notifyEvent("item/completed", obj("threadId", "remote-thread", "turnId", "turn-one",
            "item", obj("id", "command", "type", "commandExecution", "status", "completed")));
        assertTrue(runningTurns().containsKey("local-thread"));
        assertEquals(0, taskNotificationCount());
        complete(obj("id", "turn-one", "status", "completed"));
        assertEquals(1, taskNotificationCount());
    }

    @Test public void duplicateAndUntrackedCompletionsDoNotNotifyAgain() throws Exception {
        complete(obj("id", "turn-one", "status", "completed"));
        assertEquals(1, taskNotificationCount());
        notifyEvent("turn/completed", obj("threadId", "remote-thread", "turn", obj("id", "turn-one", "status", "completed")));
        notifyEvent("turn/completed", obj("threadId", "unknown-child", "turn", obj("id", "child-turn", "status", "completed")));
        assertEquals(1, taskNotificationCount());
        assertFalse(state.getBoolean("busy"));
    }

    @Test public void staleCompletionCannotStopTheCurrentTurn() throws Exception {
        notifyEvent("turn/completed", obj("threadId", "remote-thread", "turn", obj("id", "old-turn", "status", "completed")));
        assertEquals("turn-one", runningTurns().get("local-thread"));
        assertEquals(0, taskNotificationCount());
    }

    @Test public void incompleteCompletionEventsLeaveTheTrackedTaskRunning() throws Exception {
        notifyEvent("turn/completed", obj("threadId", "remote-thread"));
        notifyEvent("turn/completed", obj("threadId", "remote-thread", "turn", obj("status", "completed")));
        assertEquals("turn-one", runningTurns().get("local-thread"));
        assertTrue(state.getBoolean("busy"));
        assertTrue(session.getBoolean("approvalPending"));
        assertEquals(0, taskNotificationCount());
    }

    private void notifyEvent(String name, JSONObject params) throws Exception {
        Method notification = Engine.class.getDeclaredMethod("onNotification", String.class, JSONObject.class);
        notification.setAccessible(true);
        engine.io.submit(() -> { notification.invoke(engine, name, params); return null; }).get(5, TimeUnit.SECONDS);
    }
    private long taskNotificationCount() {
        return shadowOf(application).getBroadcastIntents().stream()
            .filter(intent -> CodexNotificationReceiver.ACTION.equals(intent.getAction())).count();
    }

    private void complete(JSONObject turn) throws Exception { notifyCompletion("remote-thread", turn); }

    private void notifyCompletion(String remoteThread, JSONObject turn) throws Exception {
        Method notification = Engine.class.getDeclaredMethod("onNotification", String.class, JSONObject.class);
        notification.setAccessible(true);
        state = null;
        engine.io.submit(() -> {
            notification.invoke(engine, "turn/completed", obj("threadId", remoteThread, "turn", turn));
            return null;
        }).get(5, TimeUnit.SECONDS);
        assertNotNull("Completion must publish fresh state; errors=" + errors, state);
    }

    private Intent lastTaskNotification() {
        List<Intent> broadcasts = shadowOf(application).getBroadcastIntents();
        for (int i = broadcasts.size() - 1; i >= 0; i--) {
            Intent intent = broadcasts.get(i);
            if (CodexNotificationReceiver.ACTION.equals(intent.getAction())) return intent;
        }
        throw new AssertionError("No task notification was broadcast");
    }

    @SuppressWarnings("unchecked")
    private Map<String, String> runningTurns() throws Exception { return (Map<String, String>) get("runningTurns"); }

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
