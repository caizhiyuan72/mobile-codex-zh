package dev.mobilecodex.app;

import static dev.mobilecodex.app.core.Texts.t;
import android.app.*;
import android.content.Intent;
import android.os.IBinder;

public final class EngineService extends Service {
    private static final String CHANNEL = "codex_runtime";
    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, t("正在进行的任务"), NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, EngineService.class).setAction("stop"), PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.notification_icon).setContentTitle(t("Codex CN"))
            .setContentText(t("正在此设备运行 · 点击打开")).setContentIntent(open).setOngoing(true)
            .addAction(new Notification.Action.Builder(null, t("退出"), stop).build()).build();
        startForeground(21, notification);
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        Engine engine = ((MobileCodexApp) getApplication()).engine();
        if (intent != null && "stop".equals(intent.getAction())) {
            engine.stop();
            return START_NOT_STICKY;
        }
        engine.reconcileService();
        return START_STICKY;
    }
    @Override public void onDestroy() {
        // Explicit stop requests own process shutdown. A stale service callback must
        // not stop a newly restarted engine.
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
