package dev.mobilecodex.app;

import android.app.Application;
import dev.mobilecodex.app.core.Texts;
import org.json.JSONObject;
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
        Texts.configure(true, Map.of());
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
                if ("agent.event".equals(name)) activity.add(data);
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
        Texts.configure(true, Map.of());
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

    @Test public void legacyImplicitCurrentThreadStillHasALocalScope() throws Exception {
        notifyEvent("item/commandExecution/outputDelta", obj("itemId", "command", "delta", "legacy output"));
        assertEquals(1, activity.size());
        assertEquals("current-local", activity.get(0).getString("threadId"));
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
