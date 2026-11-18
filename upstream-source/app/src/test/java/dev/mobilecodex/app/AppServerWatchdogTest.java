package dev.mobilecodex.app;

import dev.mobilecodex.app.core.RpcClient;
import org.json.JSONObject;
import org.junit.Test;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeoutException;
import static dev.mobilecodex.app.core.Json.obj;
import static org.junit.Assert.*;

public class AppServerWatchdogTest {
    @Test public void threeActualTimeoutsRequiredAndAnyIncomingResponseResetsTheCount() {
        var probes = new ArrayList<CompletableFuture<JSONObject>>();
        try (var rpc = new RpcClient(new ByteArrayInputStream(new byte[0]), new ByteArrayOutputStream(), null)) {
            var watchdog = new AppServerWatchdog(rpc, () -> {
                var reply = new CompletableFuture<JSONObject>();
                probes.add(reply);
                return reply;
            });
            assertFalse(watchdog.unresponsive());
            for (int i = 0; i < 6; i++) assertFalse(watchdog.unresponsive());
            assertEquals(1, probes.size());
            probes.get(0).completeExceptionally(new TimeoutException());
            assertFalse(watchdog.unresponsive());
            probes.get(1).completeExceptionally(new TimeoutException());
            assertFalse(watchdog.unresponsive());
            probes.get(2).completeExceptionally(new TimeoutException());
            rpc.accept(obj("id", 99, "result", obj())); // A late reply from another RPC proves liveness.
            assertFalse(watchdog.unresponsive());
            assertFalse(watchdog.unresponsive());
            for (int i = 3; i < 6; i++) {
                probes.get(i).completeExceptionally(new TimeoutException());
                assertEquals(i == 5, watchdog.unresponsive());
            }
        }
    }
}
