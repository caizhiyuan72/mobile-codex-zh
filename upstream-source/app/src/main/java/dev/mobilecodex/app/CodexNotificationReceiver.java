package dev.mobilecodex.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.provider.Settings;
import android.os.Build;
import static dev.mobilecodex.app.core.Texts.t;

/** Posts durable task notifications even when MainActivity is not attached. */
public final class CodexNotificationReceiver extends BroadcastReceiver {
    static final String ACTION = "dev.mobilecodex.app.TASK_NOTIFICATION";
    static final String CHANNEL = "codex_task_events";
    static final String RESULTS_CHANNEL = "codex_task_results";
    static final String RESULTS_NO_VIBRATION_CHANNEL = "codex_task_results_no_vibration";
    private static final String TASK_TAG = "codex-task";
    private static final String RESULT_TAG = "codex-result:";
    private static final int RESULT_ID = 1001;
    private static volatile boolean appForeground;
    private static volatile String visibleThread = "";
    static void setAppForeground(boolean value) {
        appForeground = value;
        if (!value) visibleThread = "";
    }
    static void setVisibleThread(Context context, String threadId) {
        if (threadId.equals(visibleThread)) return;
        visibleThread = threadId;
        if (!threadId.isBlank()) {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            manager.cancel(RESULT_TAG + threadId, RESULT_ID);
            for (String kind : new String[]{"completed", "failed", "interrupted"}) {
                manager.cancel(TASK_TAG, legacyId(threadId, "", kind));
            }
        }
    }
    private static int legacyId(String threadId, String approvalId, String kind) {
        int id = Math.abs((threadId + approvalId + kind).hashCode());
        return id == 0 ? RESULT_ID : id;
    }
    @Override public void onReceive(Context context, Intent intent) {
        if (!ACTION.equals(intent.getAction())) return;
        var prefs = context.getSharedPreferences("notifications", 0);
        String threadId = intent.getStringExtra("threadId");
        if (appForeground && threadId != null && !threadId.isBlank() && threadId.equals(visibleThread)) return;
        if (!prefs.getBoolean("enabled", true)) return;
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) return;
        String kind = intent.getStringExtra("kind");
        String title = intent.getStringExtra("title");
        String message = intent.getStringExtra("message");
        String approvalId = intent.getStringExtra("approvalId");
        boolean result = "completed".equals(kind) || "failed".equals(kind) || "interrupted".equals(kind);
        boolean vibration = prefs.getBoolean("vibration", true);
        String channelId = result ? (vibration ? RESULTS_CHANNEL : RESULTS_NO_VIBRATION_CHANNEL) : CHANNEL;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (!manager.areNotificationsEnabled()) return;
        if (manager.getNotificationChannel(channelId) == null) {
            String channelName = !result ? t("Codex 작업 알림") : vibration ? t("답변 완료") : t("답변 완료") + " · " + t("진동 없음");
            NotificationChannel channel = new NotificationChannel(channelId, channelName, NotificationManager.IMPORTANCE_HIGH);
            channel.setSound(Settings.System.DEFAULT_NOTIFICATION_URI,
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build());
            if (vibration) channel.setVibrationPattern(new long[]{0, 180, 100, 180});
            channel.enableVibration(vibration);
            manager.createNotificationChannel(channel);
        }
        Intent openIntent = new Intent(context, MainActivity.class).setAction(ACTION)
            .putExtra("threadId", threadId).putExtra("approvalId", approvalId).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent open = PendingIntent.getActivity(context, (threadId + approvalId).hashCode(), openIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(context, channelId);
        builder.setSmallIcon(R.drawable.notification_icon).setContentTitle(title == null ? t("Mobile Codex") : title)
            .setContentText(message == null ? "" : message).setContentIntent(open).setAutoCancel(true)
            .setCategory(Notification.CATEGORY_STATUS).setVisibility(Notification.VISIBILITY_PRIVATE);
        if (result) manager.notify(RESULT_TAG + threadId, RESULT_ID, builder.build());
        else manager.notify(TASK_TAG, legacyId(threadId, approvalId, kind), builder.build());
    }
}
