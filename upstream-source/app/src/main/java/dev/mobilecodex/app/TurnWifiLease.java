package dev.mobilecodex.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiManager;
import android.os.Build;

/** Scoped to work on the default Wi-Fi network. Never binds the process to a network. */
final class TurnWifiLease {
    private final Context app;
    private final ConnectivityManager networks;
    private WifiManager.WifiLock lock;
    private ConnectivityManager.NetworkCallback request;

    TurnWifiLease(Context context) {
        app = context.getApplicationContext();
        networks = app.getSystemService(ConnectivityManager.class);
    }

    @SuppressWarnings("deprecation")
    void update(boolean working) {
        try {
            NetworkCapabilities caps = working && networks != null
                ? networks.getNetworkCapabilities(networks.getActiveNetwork()) : null;
            if (caps == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                    || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
                release();
                return;
            }
            if (Build.VERSION.SDK_INT >= 34) {
                // HIGH_PERF maps to a screen-on low-latency lock on modern Android.
                // Express the active app's need for Wi-Fi directly to ConnectivityService.
                if (request == null) {
                    var callback = new ConnectivityManager.NetworkCallback();
                    var wifi = new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build();
                    networks.requestNetwork(wifi, callback);
                    request = callback;
                }
            } else {
                WifiManager wifi = app.getSystemService(WifiManager.class);
                if (wifi == null) return;
                if (lock == null) {
                    lock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "MobileCodex:turn-wifi");
                    lock.setReferenceCounted(false);
                }
                if (!lock.isHeld()) lock.acquire();
            }
        } catch (RuntimeException unavailable) {
            // A denied network request must not interrupt the turn. Retry at the next check.
            release();
        }
    }

    private void release() {
        if (request != null) {
            try { networks.unregisterNetworkCallback(request); } catch (RuntimeException ignored) { }
            request = null;
        }
        if (lock != null) {
            try { if (lock.isHeld()) lock.release(); } catch (RuntimeException ignored) { }
            lock = null;
        }
    }
}
