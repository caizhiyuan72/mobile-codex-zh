package dev.mobilecodex.app;

import android.accessibilityservice.AccessibilityService;
import android.app.Application;
import android.os.Looper;
import android.os.PowerManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import dev.mobilecodex.app.core.PhoneControlGate;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.LooperMode;
import org.robolectric.shadows.ShadowAccessibilityService;
import org.robolectric.shadow.api.Shadow;
import java.time.Duration;
import java.util.Set;
import java.util.concurrent.*;
import static dev.mobilecodex.app.core.Json.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = {29, 35}, application = Application.class, shadows = PhoneServiceDispatchTest.ScreenServiceShadow.class)
@LooperMode(LooperMode.Mode.PAUSED)
public class PhoneServiceDispatchTest {
    @Implements(AccessibilityService.class)
    public static class ScreenServiceShadow extends ShadowAccessibilityService {
        String screenLabel;
        int screenReads;

        @Implementation protected AccessibilityNodeInfo getRootInActiveWindow() {
            screenReads++;
            if (screenLabel == null) return null;
            AccessibilityNodeInfo root = AccessibilityNodeInfo.obtain();
            root.setPackageName("test.app");
            root.setVisibleToUser(true);
            root.setText(screenLabel);
            return root;
        }
    }

    private PhoneUseService service;
    private PhoneControlGate gate;
    private ExecutorService worker;
    @Before public void before() throws Exception {
        service = Robolectric.buildService(PhoneUseService.class).create().get(); service.onServiceConnected();
        Shadows.shadowOf(service.getSystemService(PowerManager.class)).setIsInteractive(true);
        java.lang.reflect.Field field = PhoneUseService.class.getDeclaredField("gate"); field.setAccessible(true);
        gate = (PhoneControlGate) field.get(service); gate.enable();
        worker = Executors.newSingleThreadExecutor();
    }
    @After public void after() { service.onDestroy(); worker.shutdownNow(); Shadows.shadowOf(Looper.getMainLooper()).idle(); }
    private Future<JSONObject> action(JSONObject args) { return worker.submit(() -> PhoneUseService.execute(service, "mobile_phone_action", args)); }
    private Future<JSONObject> home() { return action(obj("action", "home")); }
    private ScreenServiceShadow screenShadow() { return Shadow.extract(service); }
    private void waitForHomeDispatch() throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (screenShadow().getGlobalActionsPerformed().isEmpty() && System.nanoTime() < deadline) {
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            Thread.sleep(2);
        }
        assertEquals(java.util.List.of(AccessibilityService.GLOBAL_ACTION_HOME), screenShadow().getGlobalActionsPerformed());
    }
    private static JSONObject actionResult(Future<JSONObject> result) throws Exception {
        JSONObject response = result.get(1, TimeUnit.SECONDS);
        assertTrue(response.getBoolean("success"));
        assertEquals(1, response.getJSONArray("contentItems").length());
        return parse(response.getJSONArray("contentItems").getJSONObject(0).getString("text"));
    }
    @Test public void globalActionActuallyDispatchesToAndroid() throws Exception {
        Future<JSONObject> result = home();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (!result.isDone() && System.nanoTime() < deadline) { Shadows.shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(2); }
        assertTrue(result.get(1, TimeUnit.SECONDS).getBoolean("success"));
        assertEquals(java.util.List.of(AccessibilityService.GLOBAL_ACTION_HOME), Shadows.shadowOf(service).getGlobalActionsPerformed());
        assertEquals(0, screenShadow().screenReads);
    }
    @Test public void combinedActionReturnsNewNodesAfterRecentChangesSettle() throws Exception {
        screenShadow().screenLabel = "Before";
        Future<JSONObject> result = action(obj("action", "home", "observe", "nodes"));
        waitForHomeDispatch();
        var main = Shadows.shadowOf(Looper.getMainLooper());
        main.idleFor(Duration.ofMillis(100));
        screenShadow().screenLabel = "After";
        service.onAccessibilityEvent(AccessibilityEvent.obtain(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED));
        main.idleFor(Duration.ofMillis(100));
        assertEquals(0, screenShadow().screenReads);
        main.idleFor(Duration.ofMillis(100));

        JSONObject payload = actionResult(result);
        assertTrue(payload.getBoolean("accepted"));
        assertFalse(payload.has("observationError"));
        JSONObject observation = payload.getJSONObject("observation");
        assertEquals("After", observation.getJSONArray("nodes").getJSONObject(0).getString("text"));
        java.lang.reflect.Field field = PhoneUseService.class.getDeclaredField("screen"); field.setAccessible(true);
        PhoneScreen screen = (PhoneScreen) field.get(service);
        assertFalse(observation.getString("snapshotId").isBlank());
        screen.requireFresh(observation.getString("snapshotId"), screen.revision, screen.windowId, "test.app", screen.width, screen.height);
        service.onAccessibilityEvent(AccessibilityEvent.obtain(AccessibilityEvent.TYPE_VIEW_SCROLLED));
        assertNull(field.get(service));
    }
    @Test public void actionAcceptanceIsPreservedWhenFollowupCannotReadScreen() throws Exception {
        Future<JSONObject> result = action(obj("action", "home", "observe", "nodes"));
        waitForHomeDispatch();
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1));
        JSONObject payload = actionResult(result);
        assertTrue(payload.getBoolean("accepted"));
        assertFalse(payload.has("observation"));
        assertFalse(payload.getString("observationError").isBlank());
        assertEquals("mobile_phone_screen", payload.getString("verify"));
    }
    @Test public void continuouslyChangingScreenDoesNotDelayObservationIndefinitely() throws Exception {
        screenShadow().screenLabel = "Updating";
        Future<JSONObject> result = action(obj("action", "home", "observe", "nodes"));
        waitForHomeDispatch();
        var main = Shadows.shadowOf(Looper.getMainLooper());
        for (int elapsed = 0; elapsed < 750; elapsed += 75) {
            main.idleFor(Duration.ofMillis(75));
            service.onAccessibilityEvent(AccessibilityEvent.obtain(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED));
        }
        assertEquals(0, screenShadow().screenReads);
        main.idleFor(Duration.ofMillis(50));
        assertTrue(actionResult(result).has("observation"));
    }
    @Test public void stopDiscardsQueuedFollowupEvenAfterReenable() throws Exception {
        screenShadow().screenLabel = "Should not be read";
        Future<JSONObject> result = action(obj("action", "home", "observe", "nodes"));
        waitForHomeDispatch();
        PhoneUseService.stopControl(); gate.enable();
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1));
        assertThrows(ExecutionException.class, () -> result.get(1, TimeUnit.SECONDS));
        assertEquals(0, screenShadow().screenReads);
    }
    @Test public void stopBeforeMainQueueDispatchCancelsWorkEvenAfterReenable() throws Exception {
        Future<JSONObject> result = home();
        java.lang.reflect.Field field = PhoneUseService.class.getDeclaredField("pending"); field.setAccessible(true);
        Set<?> pending = (Set<?>) field.get(service);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (pending.isEmpty() && System.nanoTime() < deadline) Thread.sleep(2);
        assertFalse(pending.isEmpty()); PhoneUseService.stopControl(); gate.enable();
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertThrows(ExecutionException.class, () -> result.get(1, TimeUnit.SECONDS));
        assertTrue(Shadows.shadowOf(service).getGlobalActionsPerformed().isEmpty());
    }
    @Test public void serviceDisconnectDisarmsAndCannotResumeByReconnecting() {
        service.onInterrupt(); assertFalse(PhoneUseService.status(service).optBoolean("enabled"));
        service.onServiceConnected(); assertFalse(PhoneUseService.status(service).optBoolean("enabled"));
    }
    @Test public void delayedStopCleanupDoesNotRemoveReenabledEmergencyControl() throws Exception {
        java.lang.reflect.Field field = PhoneUseService.class.getDeclaredField("stopButton"); field.setAccessible(true);
        android.widget.Button control = new android.widget.Button(service); field.set(service, control);
        worker.submit(PhoneUseService::stopControl).get(1, TimeUnit.SECONDS);
        gate.enable();
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertSame(control, field.get(service));
        PhoneUseService.stopControl();
        assertNull(field.get(service));
    }
}
