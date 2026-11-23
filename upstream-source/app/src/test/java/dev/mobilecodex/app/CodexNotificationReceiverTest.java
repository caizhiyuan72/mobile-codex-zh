package dev.mobilecodex.app;

import android.app.Notification;
import android.app.Application;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import org.junit.Before;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowNotificationManager;
import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 32, application = Application.class)
public class CodexNotificationReceiverTest {
    private Context context;
    private NotificationManager manager;

    @Before public void before() {
        context = RuntimeEnvironment.getApplication();
        manager = context.getSystemService(NotificationManager.class);
        manager.cancelAll();
        CodexNotificationReceiver.setAppForeground(false);
        context.getSharedPreferences("notifications", 0).edit().clear().commit();
    }

    @After public void after() { CodexNotificationReceiver.setAppForeground(false); }

    @Test public void backgroundCompletionPostsNotification() {
        context.getSharedPreferences("notifications", 0).edit()
            .putBoolean("enabled", true).putBoolean("foreground", false)
            .putString("visibleThread", "thread-one").commit();
        Intent intent = Engine.taskNotificationIntent(context, "completed", "답변 완료",
            "Codex가 작업을 마쳤습니다.", "thread-one", "");

        assertEquals(CodexNotificationReceiver.class.getName(), intent.getComponent().getClassName());
        context.sendBroadcast(intent);
        shadowOf(android.os.Looper.getMainLooper()).idle();

        ShadowNotificationManager notifications = shadowOf(manager);
        assertEquals(1, notifications.size());
        assertEquals(NotificationManager.IMPORTANCE_HIGH,
            manager.getNotificationChannel(CodexNotificationReceiver.RESULTS_CHANNEL).getImportance());
        assertNotNull(manager.getNotificationChannel(CodexNotificationReceiver.RESULTS_CHANNEL).getSound());
        assertNotEquals(0, manager.getActiveNotifications()[0].getNotification().flags & Notification.FLAG_AUTO_CANCEL);
    }

    @Test public void foregroundCompletionOnlyStaysSilentForTheVisibleConversation() {
        CodexNotificationReceiver.setAppForeground(true);
        CodexNotificationReceiver.setVisibleThread(context, "thread-one");
        CodexNotificationReceiver receiver = new CodexNotificationReceiver();
        receiver.onReceive(context, Engine.taskNotificationIntent(context, "completed", "Done", "Task finished", "thread-two", ""));
        assertEquals(1, shadowOf(manager).size());
        receiver.onReceive(context, Engine.taskNotificationIntent(context, "completed", "Done", "Task finished", "thread-one", ""));
        assertEquals(1, shadowOf(manager).size());
    }
    @Test public void resumingWithoutAVisibleThreadDoesNotSilenceCompletion() {
        CodexNotificationReceiver.setAppForeground(true);
        CodexNotificationReceiver.setVisibleThread(context, "thread-one");
        CodexNotificationReceiver.setAppForeground(false);
        CodexNotificationReceiver.setAppForeground(true);
        new CodexNotificationReceiver().onReceive(context,
            Engine.taskNotificationIntent(context, "completed", "Done", "Task finished", "thread-one", ""));
        assertEquals(1, shadowOf(manager).size());
    }

    @Test public void staleForegroundPreferenceCannotSilenceANewBackgroundProcess() {
        context.getSharedPreferences("notifications", 0).edit().putBoolean("foreground", true).commit();
        new CodexNotificationReceiver().onReceive(context,
            Engine.taskNotificationIntent(context, "completed", "Done", "Task finished", "thread-one", ""));
        assertEquals(1, shadowOf(manager).size());
    }

    @Test public void disabledTaskNotificationsStaySilent() {
        context.getSharedPreferences("notifications", 0).edit().putBoolean("enabled", false).commit();
        new CodexNotificationReceiver().onReceive(context,
            new Intent(CodexNotificationReceiver.ACTION).putExtra("kind", "completed")
                .putExtra("threadId", "thread-one").putExtra("approvalId", ""));
        assertEquals(0, shadowOf(manager).size());
    }

    @Test public void openingConversationClearsItsResultAndLeavesOtherNotifications() {
        CodexNotificationReceiver receiver = new CodexNotificationReceiver();
        receiver.onReceive(context, Engine.taskNotificationIntent(context, "completed", "Done", "Finished", "thread-one", ""));
        receiver.onReceive(context, Engine.taskNotificationIntent(context, "completed", "Done", "Finished", "thread-two", ""));
        manager.notify("codex-task", Math.abs("thread-onecompleted".hashCode()),
            new Notification.Builder(context, CodexNotificationReceiver.RESULTS_CHANNEL).setContentTitle("Old result").build());
        assertEquals(3, shadowOf(manager).size());
        CodexNotificationReceiver.setAppForeground(true);
        CodexNotificationReceiver.setVisibleThread(context, "thread-one");
        assertEquals(1, shadowOf(manager).size());
        assertEquals("codex-result:thread-two", manager.getActiveNotifications()[0].getTag());
    }

    @Test public void disablingVibrationKeepsAnAudibleHighPriorityResult() {
        context.getSharedPreferences("notifications", 0).edit().putBoolean("vibration", false).commit();
        new CodexNotificationReceiver().onReceive(context,
            Engine.taskNotificationIntent(context, "completed", "Done", "Finished", "thread-one", ""));
        var channel = manager.getNotificationChannel(CodexNotificationReceiver.RESULTS_NO_VIBRATION_CHANNEL);
        assertEquals(NotificationManager.IMPORTANCE_HIGH, channel.getImportance());
        assertFalse(channel.shouldVibrate());
        assertNotNull(channel.getSound());
    }
}
