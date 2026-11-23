package dev.mobilecodex.app;

import android.app.Application;
import android.net.*;
import android.net.wifi.WifiManager;
import android.os.Build;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowNetworkCapabilities;
import org.robolectric.shadows.ShadowNetworkInfo;
import static org.robolectric.Shadows.shadowOf;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = {29, 34}, application = Application.class)
public class TurnWifiLeaseTest {
    @Test public void onlyActiveWifiWorkHoldsOneLeaseAndBothHandoffAndFinishReleaseIt() {
        Application app = RuntimeEnvironment.getApplication();
        var networks = app.getSystemService(ConnectivityManager.class);
        var wifi = app.getSystemService(WifiManager.class);
        var state = shadowOf(networks);
        var lease = new TurnWifiLease(app);
        state.setActiveNetworkInfo(ShadowNetworkInfo.newInstance(NetworkInfo.DetailedState.CONNECTED,
            ConnectivityManager.TYPE_WIFI, 0, true, true));
        var caps = ShadowNetworkCapabilities.newInstance();
        shadowOf(caps).addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        shadowOf(caps).addTransportType(NetworkCapabilities.TRANSPORT_WIFI);
        state.setNetworkCapabilities(networks.getActiveNetwork(), caps);
        int callbacks = state.getNetworkCallbacks().size();
        int locks = shadowOf(wifi).getActiveLockCount();
        for (boolean finish : new boolean[]{false, true}) {
            lease.update(true);
            lease.update(true);
            assertEquals(locks + (Build.VERSION.SDK_INT < 34 ? 1 : 0), shadowOf(wifi).getActiveLockCount());
            assertEquals(callbacks + (Build.VERSION.SDK_INT >= 34 ? 1 : 0), state.getNetworkCallbacks().size());
            var cell = ShadowNetworkCapabilities.newInstance();
            shadowOf(cell).addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR);
            shadowOf(cell).addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            if (!finish) state.setNetworkCapabilities(networks.getActiveNetwork(), cell);
            lease.update(!finish);
            assertEquals(locks, shadowOf(wifi).getActiveLockCount());
            assertEquals(callbacks, state.getNetworkCallbacks().size());
            state.setNetworkCapabilities(networks.getActiveNetwork(), caps);
        }
    }
}
