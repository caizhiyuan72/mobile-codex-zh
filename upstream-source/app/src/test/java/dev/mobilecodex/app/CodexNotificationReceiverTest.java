package dev.mobilecodex.app;

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
            manager.getNotificationChannel(CodexNotificationReceiver.CHANNEL).getImportance());
    }

    @Test public void foregroundCompletionStaysSilentAndClearsExistingTaskNotifications() {
        Intent completed = Engine.taskNotificationIntent(context, "completed", "Done", "Task finished", "thread-one", "");
        new CodexNotificationReceiver().onReceive(context, completed);
        assertEquals(1, shadowOf(manager).size());
        CodexNotificationReceiver.setAppForeground(true);
        new CodexNotificationReceiver().onReceive(context, completed);
        assertEquals(0, shadowOf(manager).size());
    }
    @Test public void returningToAppClearsTaskNotificationsButPreservesRuntimeService() {
        new CodexNotificationReceiver().onReceive(context,
            Engine.taskNotificationIntent(context, "completed", "Done", "Task finished", "thread-one", ""));
        manager.createNotificationChannel(new android.app.NotificationChannel("runtime", "Runtime", NotificationManager.IMPORTANCE_LOW));
        manager.notify(9001, new android.app.Notification.Builder(context, "runtime").setSmallIcon(android.R.drawable.ic_dialog_info).build());
        CodexNotificationReceiver.clearTaskNotifications(context);
        assertEquals(1, shadowOf(manager).size());
        assertNotNull(shadowOf(manager).getNotification(9001));
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
}
