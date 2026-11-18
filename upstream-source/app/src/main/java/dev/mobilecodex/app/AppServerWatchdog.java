package dev.mobilecodex.app;

import static dev.mobilecodex.app.core.Json.obj;
import dev.mobilecodex.app.core.RpcClient;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.function.Supplier;
import org.json.JSONObject;
import java.util.concurrent.TimeoutException;

/** One instance per transport and active work period. Sampled on the engine queue. */
final class AppServerWatchdog {
    static final long INTERVAL_MS = 15_000;
    static final long COOLDOWN_MS = 120_000;
    final RpcClient connection;
    private final Supplier<CompletableFuture<JSONObject>> probe;
    private long observed;
    private int misses;
    private CompletableFuture<Boolean> timedOut;

    AppServerWatchdog(RpcClient connection) {
        this(connection, () -> CompletableFuture.supplyAsync(() -> connection.request("thread/loaded/list", obj("limit", 1), 4))
            .thenCompose(reply -> reply));
    }

    AppServerWatchdog(RpcClient connection, Supplier<CompletableFuture<JSONObject>> probe) {
        this.connection = connection;
        this.probe = probe;
        observed = connection.receivedMessages();
    }

    boolean unresponsive() {
        long received = connection.receivedMessages();
        if (received != observed) {
            observed = received;
            misses = 0;
            if (timedOut != null && timedOut.isDone()) timedOut = null;
            return false;
        }
        if (timedOut != null) {
            // Don't count time spent waiting for the writer or a slow engine queue as missed replies.
            if (!timedOut.isDone()) return false;
            misses = timedOut.getNow(false) ? misses + 1 : 0;
            timedOut = null;
            if (misses >= 3) return connection.receivedMessages() == observed;
        }
        // A local, read-only RPC. It doesn't contact the model or change the turn.
        timedOut = probe.get().handle((reply, error) -> {
                while (error instanceof CompletionException && error.getCause() != null) error = error.getCause();
                return error instanceof TimeoutException;
            });
        return false;
    }
}
