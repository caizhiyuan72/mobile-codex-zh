package dev.mobilecodex.app;

import static dev.mobilecodex.app.core.Texts.t;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.*;
import dev.mobilecodex.app.core.*;
import static dev.mobilecodex.app.core.Json.*;

/** Owns local app-server processes outside the Activity/WebView lifecycle. */
public final class Engine {
    // Only used on the engine queue; each action/notification gets a fresh identity.
    private Object diagnosticOperation = new Object();
    private void publishDiagnostic(JSONObject value, String action) {
        publishDiagnostic(value, action, threadId);
    }
    private void publishDiagnostic(JSONObject value, String action, String scope) {
        try {
            JSONObject diagnostic = ErrorReports.withOperation(value, action);
            // Native correlation only; ErrorReports never includes this in a report.
            if ("chat".equals(diagnostic.optString("operation"))) diagnostic.put("_scope", scope);
            event("diagnostics.available", diagnostic);
        } catch (Exception ignored) { /* Diagnostic handling must preserve the original failure. */ }
    }
    private void error(String action, JSONObject data) {
        error(action, data, null);
    }
    private void error(String action, JSONObject data, Throwable failure) {
        JSONObject diagnostic = DiagnosticFailure.snapshot(failure, diagnosticOperation);
        if (failure == null) {
            String code = action.equals("auth.login") ? "login_failed" : action.equals("sessions.save") ? "storage_failure" : "operation_failed";
            diagnostic = obj("errorCode", code, "stage", "unknown", "homeKind", "unknown");
        }
        publishDiagnostic(diagnostic, action, data.has("threadId") ? data.optString("threadId") : threadId);
        event("error", data);
    }
    /** State events are frequent and cross the WebView bridge, so only expose a bounded tail. */
    private static final int SNAPSHOT_MESSAGE_LIMIT = 40;
    public interface Ui {
        void event(String name, JSONObject data);
        void approval(Approval approval);
    }
    public interface Reply { void complete(JSONObject result, Throwable error); }
    /** Narrow in-process seam for protocol regression tests; production always uses RpcClient. */
    interface TestTransport { JSONObject call(String method, JSONObject params) throws Exception; }
    public static final class Approval {
        public final String id = UUID.randomUUID().toString();
        public final String title, message;
        public final CompletableFuture<Boolean> decision = new CompletableFuture<>();
        Approval(String title, String message) { this.title = title; this.message = message; }
    }
    private final Context context;
    public final DocumentStore documents;
    final ImageStore images;
    final AttachmentStore attachments;
    public final ExecutorService io = Executors.newSingleThreadExecutor();
    private final java.util.concurrent.atomic.AtomicLong chatNavigation = new java.util.concurrent.atomic.AtomicLong();
    private final ExecutorService modelDiscovery = new ThreadPoolExecutor(0, 1, 30, TimeUnit.SECONDS, new SynchronousQueue<>());
    private final ScheduledExecutorService approvalTimer = Executors.newSingleThreadScheduledExecutor();
    private volatile Ui ui;
    private final Set<Ui> observers = new CopyOnWriteArraySet<>();
    private final ChangeReview changes;
    private Process process;
    private RpcClient rpc;
    private String draftProviderId = "", runtimeScope = "", eventScope = "";
    private record ParkedRuntime(Process process, RpcClient connection, File home) {}
    private final Map<String, ParkedRuntime> parkedRuntimes = new HashMap<>();
    private TestTransport testTransport;
    private volatile boolean ready, busy;
    /** Turn ids are scoped to their server thread. The UI may move to another
     * conversation while an earlier thread continues in the same app-server. */
    private final Map<String, String> runningTurns = new HashMap<>();
    private final Map<String, TurnAgents> turnAgents = new HashMap<>();
    private final Set<String> retryingStreams = new HashSet<>();
    private final Map<String, TurnProgress> turnProgress = new HashMap<>();
    private long lastProgressPush;
    private boolean progressPushQueued;

    private JSONObject progressSnapshot() {
        TurnProgress progress = turnProgress.get(threadId);
        return progress == null ? null : progress.snapshot(rpc == null ? 0 : rpc.lastMessageAt());
    }
    private void pushProgress() {
        JSONObject progress = progressSnapshot();
        if (progress != null) event("turn.progress", obj("threadId", threadId, "progress", progress));
        lastProgressPush = android.os.SystemClock.elapsedRealtime();
    }
    private void queueProgress() {
        if (progressPushQueued) return;
        long delay = lastProgressPush + 200 - android.os.SystemClock.elapsedRealtime();
        if (delay <= 0) { pushProgress(); return; }
        progressPushQueued = true;
        approvalTimer.schedule(() -> {
            if (!io.isShutdown()) io.execute(() -> { progressPushQueued = false; pushProgress(); });
        }, delay, TimeUnit.MILLISECONDS);
    }
    private String toolRequestThread = "";
    private String permissionMode, approvalMode;
    private final Map<String, PendingRequest> requests = new LinkedHashMap<>();
    private final TerminalSession terminal = new TerminalSession((name, data) -> {
        event(name, data);
        if (name.equals("terminal.state") && !io.isShutdown()) io.execute(() -> {
            syncTaskCpu();
            stopServiceIfIdle();
        });
    });
    private String status = t("시작할 준비가 됐습니다"), turnId = "", serverThreadId = "";
    private volatile String threadId = "";
    private String serverInstructions = "";
    private String authState = "unconfigured", authError = "";
    private final android.content.SharedPreferences runtimeRecovery;
    private final android.os.PowerManager.WakeLock taskCpu;
    private final Handler powerHandler = new Handler(Looper.getMainLooper());
    private final Runnable renewTaskLease = this::renewTaskCpu;
    private final TurnWifiLease turnWifi;
    private TurnMonitor turnMonitor;
    private long nextWatchdogRestart;
    private boolean taskLeaseActive;
    private boolean turnServiceActive;
    private boolean startingTurn;
    private Object deferredSessionSave;
    private final ApiProviders apiProviders;
    private final GitHubAuth githubAuth;
    private final GitHubCredentials githubCredentials;
    private JSONArray models = new JSONArray();
    private JSONArray sessions = new JSONArray();
    private JSONObject active;
    private Approval pendingApproval;
    private File stateFile;
    private SessionStore sessionStore;
    private final File workDir;
    private final CodexHome codexHome;
    /** Isolated CODEX_HOME for the selected provider and credential revision. */
    private File processHome;
    private final PersonalInstructions instructions;
    private final DevTools devTools;
    private final LinuxRuntime linux;
    private record PendingRequest(RpcClient connection, Object id, String method, JSONObject params, String scope) {}

    public Engine(Context context) { this(context, null); }
    Engine(Context context, ApiProviders providers) {
        this(context, providers, null);
    }
    Engine(Context context, ApiProviders providers, GitHubAuth github) {
        this.context = context;
        runtimeRecovery = context.getSharedPreferences("runtime-recovery", 0);
        taskCpu = context.getSystemService(android.os.PowerManager.class).newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "MobileCodex:turn");
        taskCpu.setReferenceCounted(false);
        turnWifi = new TurnWifiLease(context);
        permissionMode = context.getSharedPreferences("settings", 0).getString("permissions", "workspace-write");
        approvalMode = context.getSharedPreferences("settings", 0).getString("approvalMode", "auto-review");
        documents = new DocumentStore(context);
        images = new ImageStore(context);
        attachments = new AttachmentStore(context, images);
        try { codexHome = CodexHome.open(context); }
        catch (IOException e) { throw new IllegalStateException(t("Codex 홈을 준비하지 못했습니다."), e); }
        try { apiProviders = providers == null ? new ApiProviders(context) : providers; }
        catch (IOException error) { throw new IllegalStateException("无法读取 API 服务商设置。", error); }
        draftProviderId = apiProviders.activeId();
        runtimeScope = providerScope();
        authState = apiProviders.configured() ? "configured" : "unconfigured";
        processHome = codexHome.root();
        instructions = new PersonalInstructions(codexHome);
        githubAuth = github == null ? new GitHubAuth(context, value -> event("github.changed", value)) : github;
        githubCredentials = new GitHubCredentials(context, githubAuth::credentialForGit, githubAuth::agentStatus);
        devTools = new DevTools(context);
        devTools.setGitHubCredentials(githubCredentials);
        linux = new LinuxRuntime(context, devTools, this::linuxChanged);
        changes = new ChangeReview(new File(context.getFilesDir(), "change-backups"), this::git);
        workDir = new File(context.getFilesDir(), "workspace"); workDir.mkdirs();
        stateFile = new File(context.getFilesDir(), "sessions.json");
        sessionStore = new SessionStore(stateFile);
        try { sessions = sessionStore.sessions(); } catch (IOException impossible) { throw new IllegalStateException(impossible); }
        if (!sessionStore.recoveryRequired()) restoreSessionProjects();
        refreshApiState();
    }
    public void attach(Ui ui) {
        this.ui = ui;
        io.execute(() -> {
            if (this.ui != ui) return;
            publish();
            if (pendingApproval != null && !pendingApproval.decision.isDone()) ui.approval(pendingApproval);
            requests.forEach((key, request) -> event("server.request", obj("key", key, "method", request.method, "params", requestUiParams(request))));
        });
    }
    public void detach(Ui ui) { if (this.ui == ui) this.ui = null; }
    String visibleThreadId() { return threadId; }
    void restoreVisibleThread(String savedId) {
        if (savedId.isBlank()) return;
        io.execute(() -> {
            if (active != null || sessionStore.recoveryRequired()) return;
            JSONObject saved = session(savedId);
            if (saved == null || saved.optBoolean("deletionPending")) return;
            try { resume(savedId, 0); publish(); } catch (Exception ignored) { }
        });
    }
    void resumeForeground(Ui owner) {
        attach(owner);
        io.execute(() -> {
            if (ui != owner) return;
            refreshApiState();
            recoverRememberedRuntime(true);
            publish();
        });
    }
    private void recoverRememberedRuntime(boolean fromActivity) {
        if (healthyTransport() || sessionStore.recoveryRequired()) return;
        String scope = providerScope();
        if (scope.isBlank() || !scope.equals(runtimeRecovery.getString("scope", ""))) return;
        if (!fromActivity && !scope.equals(runtimeRecovery.getString("backgroundScope", ""))) return;
        runtimeRecovery.edit().remove("backgroundScope").apply();
        try {
            start(false);
            if (active != null && sessionProviderMatches(active) && active.optString("workspaceKey").equals(documents.key())
                    && documents.workspace().optBoolean("available")) resumeRemote(false);
        } catch (Exception failure) {
            runtimeRecovery.edit().putString("scope", scope).apply();
            error("runtime.start", obj("message", unwrap(failure).getMessage()), failure);
        }
    }
    private boolean healthyTransport() {
        return ready && (testTransport != null || (process != null && process.isAlive() && rpc != null && !rpc.isClosed()));
    }
    private String providerScope() { return active == null ? apiProviders.scope(draftProviderId) : active.optString("apiScope"); }
    private String providerId() {
        if (active == null) return draftProviderId;
        String scope = providerScope();
        int separator = scope.indexOf(':');
        return separator < 0 ? "" : scope.substring(0, separator);
    }
    private boolean providerAvailable() {
        return !providerScope().isBlank() && providerScope().equals(apiProviders.scope(providerId()));
    }
    private void activateChatRuntime() {
        String next = providerScope();
        if (runtimeScope.equals(next)) return;
        if (process != null && rpc != null) {
            if (runningTurns.keySet().stream().anyMatch(id -> inProviderScope(session(id), runtimeScope)))
                parkedRuntimes.put(runtimeScope, new ParkedRuntime(process, rpc, processHome));
            else retireProviderRuntime(runtimeScope);
        }
        ParkedRuntime parked = parkedRuntimes.remove(next);
        process = parked == null ? null : parked.process;
        rpc = parked == null ? null : parked.connection;
        processHome = parked == null ? codexHome.root() : parked.home;
        ready = parked != null && process.isAlive() && !rpc.isClosed();
        runtimeScope = next;
        serverThreadId = "";
        status = ready ? t("연결됨") : t("시작할 준비가 됐습니다");
        refreshApiState();
    }
    private void rememberRuntime() { runtimeRecovery.edit().putString("scope", providerScope()).apply(); }
    private void refreshApiState() {
        authState = providerAvailable() ? "configured" : "unconfigured";
        authError = "";
        try { models = providerAvailable() ? ApiProviderPolicy.modelCatalog(apiProviders.profileDetails(providerId())) : new JSONArray(); }
        catch (IOException error) { models = new JSONArray(); authState = "error"; authError = error.getMessage(); }
    }
    public void observe(Ui observer) { observers.add(observer); io.execute(() -> {
        if (!observers.contains(observer)) return;
        observer.event("state", snapshot());
        if (pendingApproval != null && !pendingApproval.decision.isDone()) observer.approval(pendingApproval);
        requests.forEach((key, request) -> observer.event("server.request", obj("key", key, "method", request.method, "params", requestUiParams(request))));
    }); }
    public void unobserve(Ui observer) { observers.remove(observer); }
    void setTestTransport(TestTransport value) { testTransport = value; }
    File processHomeForTest() { return processHome; }
    private void event(String name, JSONObject data) {
        Ui current = ui; if (current != null) current.event(name, data); for (Ui observer : observers) if (observer != current) observer.event(name, data);
    }
    private JSONObject requestUiParams(PendingRequest request) {
        try {
            JSONObject result = new JSONObject(request.params.toString());
            JSONObject target = sessionByCodexThreadId(result.optString("threadId"), request.scope);
            String local = target == null ? "" : target.optString("id");
            if (!local.isBlank()) result.put("threadId", local);
            return result;
        } catch (Exception ignored) { return request.params; }
    }
    static Intent taskNotificationIntent(Context context, String kind, String title, String message, String thread, String approval) {
        return new Intent(context, CodexNotificationReceiver.class).setAction(CodexNotificationReceiver.ACTION)
            .putExtra("kind", kind).putExtra("title", title).putExtra("message", message)
            .putExtra("threadId", thread == null ? "" : thread).putExtra("approvalId", approval == null ? "" : approval);
    }
    private void taskNotification(String kind, String title, String message, String thread, String approval) {
        context.sendBroadcast(taskNotificationIntent(context, kind, title, message, thread, approval));
    }
    static long lastMessageAt(JSONObject session) {
        JSONArray messages = session.optJSONArray("messages");
        for (int index = messages == null ? -1 : messages.length() - 1; index >= 0; index--) {
            JSONObject message = messages.optJSONObject(index);
            if (message != null && message.optLong("createdAt") > 0) return message.optLong("createdAt");
        }
        return 0;
    }
    private JSONObject snapshot() {
        JSONArray summaries = new JSONArray();
        for (int i = sessions.length() - 1; i >= 0; i--) {
            JSONObject s = sessions.optJSONObject(i);
            if (s != null && !s.optBoolean("deletionPending")) summaries.put(obj("id", s.optString("id"), "title", s.optString("title"),
                "workspace", s.optString("workspace"), "workspaceKey", s.optString("workspaceKey"), "projectId", documents.projectId(s.optString("workspaceKey")),
                "lastMessageAt", lastMessageAt(s), "busy", runningTurns.containsKey(s.optString("id")),
                "approvalPending", s.optBoolean("approvalPending")));
        }
        JSONObject providers = apiProviders.snapshot();
        return obj("ready", ready, "busy", busy, "status", t(status), "account", obj("type", "apiKey"), "sessionStorage", sessionStore.status(),
            "authState", authState, "authError", t(authError),
            "apiProviders", providers.optJSONArray("apiProviders"), "apiActive", providerId(),
            "apiDefault", apiProviders.activeId(), "apiScope", providerScope(), "apiCanRebind", active != null && !providerAvailable(),
            "apiMigrationError", providers.optString("apiMigrationError"),
            "github", githubAuth.status().optJSONObject("github"),
            "models", models, "workspace", documents.workspace(), "projects", documents.projects(), "sessions", summaries,
            "threadId", threadId, "turnId", turnId, "liveTaskActivity", BuildConfig.APPLICATION_ID.endsWith(".fresh"), "persistedWorkActivity", true,
            "streamRetrying", retryingStreams.contains(threadId),
            "turnProgress", progressSnapshot(),
            "subagentUsage", turnAgents.containsKey(threadId) ? turnAgents.get(threadId).snapshot()
                : active == null ? JSONObject.NULL : uiJsonCopy(active.optJSONObject("subagentUsage")),
            "conversationFailure", active == null ? JSONObject.NULL : uiJsonCopy(active.optJSONObject("conversationFailure")),
            "turnDiff", active == null ? "" : active.optString("turnDiff"), "messages", snapshotMessages(),
            "messageHistory", messageHistory(active == null ? null : active.optJSONArray("messages"), snapshotMessageStart()),
            "fastMode", active != null && active.optBoolean("fastMode"),
            "pendingDeletionCount", pendingDeletionCount(), "devtools", devTools.status(), "linux", linux.status(),
            "phone", PhoneUseService.status(context), "phoneToolsAvailable", active == null || active.optInt("phoneToolsVersion") >= 1,
            "permissions", permissionMode, "approvalMode", approvalMode, "allFilesAccess", (Build.VERSION.SDK_INT >= 30 ? Environment.isExternalStorageManager() : context.checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE) == android.content.pm.PackageManager.PERMISSION_GRANTED),
            "directWorkspace", documents.directDirectory() != null, "cwd", projectDirectory().getAbsolutePath(), "terminal", terminal.snapshot());
    }
    /** Return the most recent messages in their original chronological order. */
    private JSONArray snapshotMessages() {
        JSONArray messages = active == null ? null : active.optJSONArray("messages");
        if (messages == null) return new JSONArray();
        int start = Math.max(0, messages.length() - SNAPSHOT_MESSAGE_LIMIT);
        JSONArray result = new JSONArray();
        // MainActivity serializes events after crossing to the UI thread.
        // Copy this bounded page so a later streaming delta cannot mutate an
        // already-emitted state snapshot before WebView serialization.
        for (int i = start; i < messages.length(); i++) result.put(uiJsonCopy(messages.opt(i)));
        return result;
    }
    private static Object uiJsonCopy(Object value) {
        try {
            if (value instanceof JSONObject) return new JSONObject(value.toString());
            if (value instanceof JSONArray) return new JSONArray(value.toString());
        } catch (Exception ignored) { }
        return value;
    }
    private int snapshotMessageStart() {
        JSONArray messages = active == null ? null : active.optJSONArray("messages");
        return messages == null ? 0 : Math.max(0, messages.length() - SNAPSHOT_MESSAGE_LIMIT);
    }
    /** Metadata points to the first returned item; history requests exclude that cursor item. */
    private JSONObject messageHistory(JSONArray messages, int start) {
        int total = messages == null ? 0 : messages.length();
        start = Math.max(0, Math.min(total, start));
        String beforeId = "";
        if (start > 0) {
            JSONObject first = messages.optJSONObject(start);
            beforeId = first == null ? "" : first.optString("id");
        }
        return obj("hasMore", start > 0, "beforeId", beforeId, "total", total);
    }
    private void publish() { if (ui != null || !observers.isEmpty()) event("state", snapshot()); }
    private void completeNavigation(long navigation, Reply reply) {
        JSONObject current = snapshot();
        event("state", current);
        reply.complete(navigation == 0 ? current : obj("ok", true), null);
    }
    private synchronized void syncTaskCpu() {
        boolean hasTurn = startingTurn || !runningTurns.isEmpty();
        if (hasTurn && !turnServiceActive) context.startForegroundService(new Intent(context, EngineService.class));
        boolean turnEnded = turnServiceActive && !hasTurn;
        turnServiceActive = hasTurn;
        boolean needed = hasTurn && !waitingForOnlyTurnApproval();
        if (turnEnded) stopServiceIfIdle();
        if (taskLeaseActive == needed) return;
        taskLeaseActive = needed;
        turnWifi.update(needed);
        if (needed) {
            turnMonitor = new TurnMonitor();
            turnMonitor.schedule();
            renewTaskCpu();
        } else {
            powerHandler.removeCallbacks(turnMonitor);
            turnMonitor = null;
            powerHandler.removeCallbacks(renewTaskLease);
            if (taskCpu.isHeld()) taskCpu.release();
        }
    }
    private boolean waitingForOnlyTurnApproval() {
        if (startingTurn || runningTurns.size() != 1 || requests.size() != 1
                || terminal.busy() || linux.status().optBoolean("busy")) return false;
        var turn = runningTurns.entrySet().iterator().next();
        TurnAgents agents = turnAgents.get(turn.getKey());
        if (agents != null && agents.total() != 0) return false;
        JSONObject target = session(turn.getKey());
        if (target == null) return false;
        String remote = codexThreadId(target);
        if (remote.isBlank()) return false;
        PendingRequest request = requests.values().iterator().next();
        return request.method.endsWith("/requestApproval")
            && inProviderScope(target, request.scope) && remote.equals(request.params.optString("threadId"))
            && turn.getValue().equals(request.params.optString("turnId"));
    }
    private final class TurnMonitor implements Runnable {
        private AppServerWatchdog watchdog;
        void schedule() { powerHandler.postDelayed(this, AppServerWatchdog.INTERVAL_MS); }
        @Override public void run() {
            if (!io.isShutdown()) io.execute(this::check);
        }
        private void check() {
            // A queued check from before stop, engine replacement or the last turn's completion.
            if (turnMonitor != this) return;
            turnWifi.update(true);
            if (ready && rpc != null && process != null && !runningTurns.isEmpty()) {
                if (!process.isAlive() || rpc.isClosed()) {
                    codexDisconnected(process, rpc, null, new RuntimeFailure.Tail());
                } else if (!requests.isEmpty() || (pendingApproval != null && !pendingApproval.decision.isDone())
                        || android.os.SystemClock.elapsedRealtime() < nextWatchdogRestart) {
                    watchdog = null;
                } else {
                    if (watchdog == null || watchdog.connection != rpc)
                        watchdog = new AppServerWatchdog(rpc);
                    if (watchdog.unresponsive()) {
                        nextWatchdogRestart = android.os.SystemClock.elapsedRealtime() + AppServerWatchdog.COOLDOWN_MS;
                        codexDisconnected(process, rpc, new IOException("本地引擎连续三次未响应健康检查。"), new RuntimeFailure.Tail());
                    }
                }
            }
            if (turnMonitor == this) { pushProgress(); schedule(); }
        }
    }
    private synchronized void renewTaskCpu() {
        if (!taskLeaseActive) return;
        taskCpu.acquire(TimeUnit.MINUTES.toMillis(15));
        powerHandler.removeCallbacks(renewTaskLease);
        powerHandler.postDelayed(renewTaskLease, TimeUnit.MINUTES.toMillis(5));
    }
    private void persist() {
        try { persistSessions(sessions); }
        catch (IOException e) { error("sessions.save", obj("message", t("대화 기록을 저장하지 못했습니다."))); }
    }
    private void persistSoon() {
        if (deferredSessionSave != null) return;
        Object batch = new Object();
        deferredSessionSave = batch;
        approvalTimer.schedule(() -> {
            if (!io.isShutdown()) io.execute(() -> {
                if (deferredSessionSave != batch) return;
                deferredSessionSave = null;
                persist();
            });
        }, 2, TimeUnit.SECONDS);
    }
    /** Writes an already-staged session state. Mutating RPCs use this directly so they cannot report a durable success on I/O failure. */
    private void persistSessions(JSONArray value) throws IOException {
        try {
            sessionStore.save(value);
            deferredSessionSave = null;
        }
        catch (IOException e) { throw new DiagnosticFailure.StorageFailure(t(sessionStore.recoveryRequired()
            ? "대화 기록을 불러오지 못했습니다. 원본을 보존했습니다. 복구 후 다시 시도해 주세요."
            : "대화 기록을 저장하지 못했습니다."), e); }
    }
    private int pendingDeletionCount() {
        int count = 0;
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject session = sessions.optJSONObject(i);
            if (session != null && session.optBoolean("deletionPending")) count++;
        }
        return count;
    }
    /** Test-only state-store seam for durable-write failure coverage. */
    void setStateFileForTest(File file) { stateFile = file; sessionStore = new SessionStore(file); }
    /** Reconcile durable sessions with current bindings without changing chat identity or contents. */
    private void restoreSessionProjects() {
        boolean changed = false, generalized = false;
        String original = sessions.toString();
        for (int i = 0; i < sessions.length(); i++) {
            try {
                JSONObject session = sessions.optJSONObject(i); if (session == null) continue;
                // Conversations belong to this app installation, not to the
                // credential currently used for the next Codex request.
                if (session.has("accountProfileKey")) { session.remove("accountProfileKey"); changed = true; }
                // Legacy records used the Codex server thread as the local UI id.
                // Preserve that local id for drafts while recording the remote id explicitly.
                if (!session.has("sessionVersion") && !session.optString("id").isBlank()) {
                    session.put("codexThreadId", session.optString("id")); session.put("sessionVersion", 2); changed = true;
                }
                if (session.optBoolean("deletionPending")) continue;
                if (session.has("inFlightTurn") && !runningTurns.containsKey(session.optString("id"))) {
                    session.put("conversationFailure", obj("code", "runtime_disconnected", "turnId", session.remove("inFlightTurn")));
                    session.put("approvalPending", false); changed = true;
                }
                if (!session.has("workspaceKey")) {
                    String key = documents.restoreProjectKey(session.optString("id"), "", session.optString("workspace"));
                    session.put("workspaceKey", key);
                    if (key.isBlank() && !session.optString("workspace").isBlank()) { session.put("workspace", ""); generalized = true; }
                    changed = true;
                } else if (!session.optString("workspaceKey").isBlank()) {
                    String key = documents.restoreProjectKey(session.optString("id"), session.optString("workspaceKey"), session.optString("workspace"));
                    if (!key.equals(session.optString("workspaceKey"))) {
                        session.put("workspaceKey", key);
                        if (key.isBlank()) session.put("workspace", "");
                        changed = true; generalized |= key.isBlank();
                    }
                } else if (!session.optString("workspace").isBlank()) {
                    session.put("workspace", ""); changed = true; generalized = true;
                }
                if (!session.has("messages") || session.optJSONArray("messages") == null) { session.put("messages", new JSONArray()); changed = true; }
                JSONArray restoredMessages = session.getJSONArray("messages");
                JSONObject interruptedPro = session.optJSONObject("proOperation");
                for (int m = 0; m < restoredMessages.length(); m++) {
                    JSONObject message = restoredMessages.optJSONObject(m);
                    if (message == null) continue;
                    if ("proConsultation".equals(message.optString("kind")) && "pending".equals(message.optString("status"))) {
                        message.put("status", "failed").put("error", "Pro 网页功能已移除，待处理请求已停止，不会自动重发。");
                        changed = true;
                    }
                    if (interruptedPro != null && !interruptedPro.optString("messageId").isBlank()
                            && interruptedPro.optString("messageId").equals(message.optString("id")) && "sending".equals(message.optString("status"))) {
                        message.put("status", "uncertain").put("error", "旧版 Pro 网页请求的发送结果无法确认，该功能已移除，不会自动重发。");
                        changed = true;
                    }
                }
                // Retire only the local pending marker. Existing message text and remote metadata
                // remain historical data; the deleted Pro transport and journal are never resumed.
                if (session.has("proOperation")) {
                    session.remove("proOperation"); changed = true;
                }
            } catch (Exception ignored) { }
        }
        if (changed) {
            try {
                if (generalized) backupSessionsBeforeGeneralMigration(original);
                persistSessions(sessions);
            } catch (IOException error) {
                try { sessions = new JSONArray(original); } catch (Exception ignored) { }
                throw new IllegalStateException(t("대화 작업 폴더 이전을 저장하지 못했습니다."), error);
            }
        }
    }
    private void backupSessionsBeforeGeneralMigration(String original) throws IOException {
        File backup = new File(stateFile.getParentFile(), "sessions-before-general-workspace-v1.json");
        if (backup.exists()) return;
        File pending = new File(stateFile.getParentFile(), "sessions-before-general-workspace-v1.json.tmp");
        try {
            dev.mobilecodex.app.core.Utf8Files.write(pending.toPath(), original);
            try { Files.move(pending.toPath(), backup.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE); }
            catch (java.nio.file.AtomicMoveNotSupportedException ignored) { Files.move(pending.toPath(), backup.toPath()); }
        } catch (Exception error) {
            pending.delete(); throw new IOException(t("대화 이전 복구 사본을 저장하지 못했습니다."), error);
        }
    }
    private void backupSessionsForProjectRemoval(String original) throws IOException {
        File backup = new File(stateFile.getParentFile(), "sessions-before-project-remove-" + UUID.randomUUID() + ".json");
        File pending = new File(backup.getPath() + ".tmp");
        try {
            dev.mobilecodex.app.core.Utf8Files.write(pending.toPath(), original);
            try { Files.move(pending.toPath(), backup.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE); }
            catch (java.nio.file.AtomicMoveNotSupportedException ignored) { Files.move(pending.toPath(), backup.toPath()); }
        } catch (Exception error) {
            pending.delete(); throw new IOException(t("프로젝트 연결 해제 전 대화 복구 사본을 저장하지 못했습니다."), error);
        }
    }
    private int moveSessionsToGeneral(JSONArray values, String workspaceKey) throws Exception {
        if (workspaceKey == null || workspaceKey.isBlank()) return 0;
        int moved = 0;
        for (int i = 0; i < values.length(); i++) {
            JSONObject session = values.optJSONObject(i);
            if (session == null || !workspaceKey.equals(session.optString("workspaceKey"))) continue;
            session.put("workspaceKey", "").put("workspace", ""); moved++;
        }
        return moved;
    }
    public void updatesChanged(JSONObject data) { event("updates.changed", data); }
    public boolean canInstallUpdate() { return runningTurns.isEmpty() && !VoiceInput.active() && !linux.status().optBoolean("busy") && !terminal.busy(); }
    public void voiceInputChanged() { event("voice.changed", obj()); }
    JSONObject githubStatus() { return githubAuth.status(); }
    String githubVerificationUri() { return githubAuth.verificationUri(); }
    public void phoneStateChanged() { io.execute(this::publish); }
    void prepareFileOpen(JSONObject args, java.util.function.BiConsumer<FileOpenTarget, Exception> reply) {
        io.execute(() -> {
            try {
                requireScope(args);
                reply.accept(documents.openTarget(args.getString("path")), null);
            } catch (Exception error) { reply.accept(null, error); }
        });
    }
    public void handle(String action, JSONObject args, Reply reply) {
        // Login cancellation and local sign-out must remain responsive during a Codex RPC.
        if (action.startsWith("github.")) {
            try {
                switch (action) {
                    case "github.status" -> { }
                    case "github.configure" -> githubAuth.configure(args.optString("clientId"));
                    case "github.login" -> githubAuth.begin();
                    case "github.cancel" -> githubAuth.cancel();
                    case "github.disconnect" -> githubAuth.disconnect();
                    default -> throw new IOException("不支持的 GitHub 操作。");
                }
                reply.complete(githubAuth.status(), null);
            } catch (Exception error) { reply.complete(null, error); }
            return;
        }
        // The terminal owns its bounded writer and stop deadline. These controls
        // must also respond while the Codex queue is waiting on an RPC.
        if (Set.of("terminal.input", "terminal.stop", "terminal.state").contains(action)) {
            try {
                JSONObject result;
                if (action.equals("terminal.input")) result = terminal.input(args.getString("id"), args.getString("text"));
                else { if (action.equals("terminal.stop")) terminal.stop(args.getString("id")); result = terminal.snapshot(); }
                reply.complete(result, null);
            } catch (Exception error) { reply.complete(null, unwrap(error)); }
            return;
        }
        if (action.startsWith("agents.") || action.startsWith("live.") || action.startsWith("auth.")
                || action.startsWith("chat.pro.") || action.equals("chat.agents.set") || args.optBoolean("consultPro")) {
            reply.complete(null, new IOException("此功能已从 API 专用版本移除。")); return;
        }
        // Never queue consent revocation behind a slow engine/tool operation.
        if (Set.of("phone.stop", "chat.stop", "runtime.stop", "auth.logout").contains(action)) PhoneUseService.stopControl();
        // Installation cancellation must not queue behind a long Codex RPC.
        if (action.equals("linux.cancel")) { linux.cancel(); reply.complete(linux.status(), null); return; }
        if (action.equals("providers.discover")) {
            try {
                modelDiscovery.execute(() -> {
                    JSONObject result;
                    try { result = apiProviders.discover(args); }
                    catch (Exception error) { reply.complete(null, unwrap(error)); return; }
                    reply.complete(result, null);
                });
            } catch (RejectedExecutionException error) {
                reply.complete(null, new IOException("正在读取模型列表，请稍后重试。"));
            }
            return;
        }
        long navigation = args.optBoolean("eventOnly") && Set.of("chat.resume", "chat.new", "projects.select").contains(action)
            ? chatNavigation.incrementAndGet() : 0;
        io.execute(() -> {
            if (navigation != 0 && navigation != chatNavigation.get()) { reply.complete(obj("superseded", true), null); return; }
            Object previousOperation = diagnosticOperation;
            diagnosticOperation = new Object();
            try {
                if (sessionStore.recoveryRequired() && action.startsWith("chat.") && !action.equals("chat.stop"))
                    throw new DiagnosticFailure.StorageFailure(t("대화 기록을 저장할 수 없습니다. 복구가 필요합니다. 원본은 보존되어 있습니다."), null);
                switch (action) {
                    case "sessions.storage" -> reply.complete(sessionStore.status(), null);
                    case "sessions.recover" -> {
                        ensureRuntimeSettingsIdle();
                        if (!args.optBoolean("acceptOlderSnapshot")) throw new IOException(t("이전 기록의 복원을 확인해 주세요."));
                        sessions = sessionStore.recover(args.getString("sha256"));
                        clearActive();
                        restoreSessionProjects(); publish(); reply.complete(sessionStore.status(), null);
                    }
                    case "state" -> reply.complete(snapshot(), null);
                    case "phone.stop" -> { publish(); reply.complete(snapshot(), null); }
                    case "runtime.start" -> { start(); event("diagnostics.cleared", obj("operation", "start")); reply.complete(snapshot(), null); }
                    case "providers.list" -> reply.complete(apiProviders.snapshot(), null);
                    case "providers.save" -> {
                        String previousScope = apiProviders.scope(args.optString("id"));
                        if (!previousScope.isBlank()) ensureRuntimeSettingsIdle();
                        JSONObject saved = apiProviders.save(args);
                        if (!previousScope.isBlank() && !previousScope.equals(apiProviders.scope(saved.getString("id"))))
                            retireProviderRuntime(previousScope);
                        activateChatRuntime();
                        refreshApiState(); publish(); reply.complete(saved, null);
                    }
                    case "providers.select" -> {
                        String id = args.optString("id");
                        apiProviders.select(id);
                        draftProviderId = id;
                        activateChatRuntime(); refreshApiState(); publish();
                        reply.complete(apiProviders.snapshot(), null);
                    }
                    case "chat.provider" -> {
                        requireChatScope(args);
                        if (active != null) throw new IOException("此聊天已绑定 API 服务商。请在新聊天选择另一个服务商。");
                        String id = args.getString("id");
                        apiProviders.key(id);
                        draftProviderId = id;
                        activateChatRuntime(); refreshApiState(); publish(); reply.complete(snapshot(), null);
                    }
                    case "chat.provider.rebind" -> {
                        requireChatScope(args);
                        rebindSessionProvider(args.getString("id"), args.getString("expectedThreadId"), args.getString("expectedApiScope"));
                        publish(); reply.complete(snapshot(), null);
                    }
                    case "providers.remove" -> {
                        ensureRuntimeSettingsIdle();
                        String previousScope = apiProviders.scope(args.optString("id"));
                        apiProviders.remove(args.getString("id"));
                        retireProviderRuntime(previousScope);
                        if (draftProviderId.equals(args.optString("id"))) draftProviderId = apiProviders.activeId();
                        activateChatRuntime();
                        refreshApiState(); publish(); reply.complete(apiProviders.snapshot(), null);
                    }
                    case "models.refresh" -> { refreshApiState(); publish(); reply.complete(obj("models", models), null); }
                    case "devtools.check" -> { JSONObject result = devTools.check(codexHome.root(), runtimeAliases()); publish(); reply.complete(result, null); }
                    case "linux.status" -> reply.complete(linux.status(), null);
                    case "linux.install" -> {
                        context.startForegroundService(new Intent(context, EngineService.class));
                        try { linux.install(codexHome.root(), runtimeAliases()); reply.complete(linux.status(), null); }
                        catch (Exception error) { stopServiceIfIdle(); throw error; }
                    }
                    case "linux.enable" -> {
                        ensureRuntimeSettingsIdle(); linux.setEnabled(args.getBoolean("enabled"));
                        // Re-read developer instructions on the next turn, including restored chats.
                        serverThreadId = ""; publish(); reply.complete(linux.status(), null);
                    }
                    case "linux.remove" -> {
                        ensureRuntimeSettingsIdle(); linux.remove(); serverThreadId = "";
                        publish(); reply.complete(linux.status(), null);
                    }
                    case "runtime.stop" -> { linux.cancel(); stopNow(); reply.complete(snapshot(), null); }
                    case "permissions.set" -> {
                        ensureEngineIdle();
                        String mode = args.getString("mode");
                        if (!Set.of("read-only", "workspace-write", "danger-full-access").contains(mode)) throw new IOException(t("잘못된 권한 모드입니다."));
                        permissionMode = mode;
                        context.getSharedPreferences("settings", 0).edit().putString("permissions", mode).apply();
                        if (active != null && ready) resumeRemote(true);
                        publish(); reply.complete(obj("ok", true), null);
                    }
                    case "approvals.set" -> {
                        ensureEngineIdle(); String mode = args.getString("mode");
                        if (!Set.of("ask", "auto-review", "allow-all").contains(mode)) throw new IOException(t("잘못된 승인 방식입니다."));
                        approvalMode = mode; context.getSharedPreferences("settings", 0).edit().putString("approvalMode", mode).apply();
                        if (active != null && ready) resumeRemote(true);
                        publish(); reply.complete(obj("ok", true), null);
                    }
                    case "config.read" -> { File config = new File(codexHome.root(), "config.toml"); reply.complete(obj("content", config.exists() ? dev.mobilecodex.app.core.Utf8Files.read(config.toPath()) : ""), null); }
                    case "config.save" -> {
                        ensureEngineIdle(); dev.mobilecodex.app.core.Utf8Files.write(new File(codexHome.root(), "config.toml").toPath(), args.getString("content"));
                        stopCodex(); reply.complete(obj("ok", true), null);
                    }
                    case "instructions.read" -> reply.complete(instructions.read(), null);
                    case "instructions.save" -> {
                        ensureEngineIdle(); JSONObject saved = instructions.save(args.getString("content"));
                        // AGENTS files are read when Codex starts a new execution; force that boundary after a successful write.
                        stopCodex(); reply.complete(saved, null);
                    }
                    case "rpc" -> {
                        String method = args.getString("method");
                        if (method.startsWith("account/") || method.startsWith("thread/realtime/")) throw new IOException("此 API 版本不支持账号订阅或实时语音接口。");
                        start();
                        JSONObject rpcParams = args.optJSONObject("params") == null ? new JSONObject() : new JSONObject(args.getJSONObject("params").toString());
                        if (rpcParams.has("threadId")) {
                            JSONObject local = session(rpcParams.optString("threadId"));
                            if (local == null) throw new IOException("找不到该历史会话，请重新选择会话。");
                            requireSessionProvider(local);
                            String remote = codexThreadId(local);
                            if (remote.isBlank()) throw new IOException("该会话尚未连接执行引擎，请先发送消息。");
                            rpcParams.put("threadId", remote);
                        }
                        JSONObject result = call(method, rpcParams);
                        reply.complete(result, null);
                    }
                    case "rpc.respond" -> {
                        String key = args.getString("key");
                        JSONObject result = args.getJSONObject("result");
                        PendingRequest pending = requests.remove(key);
                        if (pending == null) throw new IOException(t("이미 종료된 요청입니다."));
                        syncTaskCpu();
                        if (pending.method.contains("requestApproval")) {
                            JSONObject approvalSession = sessionByCodexThreadId(pending.params.optString("threadId"), pending.scope);
                            if (approvalSession != null) { approvalSession.put("approvalPending", false); persist(); }
                        }
                        pending.connection.respond(pending.id, result);
                        reply.complete(obj("ok", true), null);
                    }
                    case "terminal.run" -> reply.complete(runTerminal(args.getString("command")), null);
                    case "files.list" -> { requireFileScope(args); reply.complete(documents.list(args.optString("path", "")), null); }
                    case "files.search" -> { requireFileScope(args); reply.complete(documents.search(args.getString("query")), null); }
                    case "files.read" -> { requireFileScope(args); String path = args.getString("path"); reply.complete(args.optBoolean("preview") ? documents.preview(path) : documents.read(path), null); }
                    case "files.mention" -> { requireFileScope(args); reply.complete(documents.mention(args.getString("path"), attachments), null); }
                    case "images.read" -> { requireFileScope(args); reply.complete(readImage(args.getString("path")), null); }
                    case "files.mutate" -> { requireFileScope(args); mutate(args.getString("operation"), args.getJSONObject("arguments"), true, reply); }
                    case "recovery.list" -> reply.complete(obj("entries", documents.recoveryList()), null);
                    case "recovery.preview" -> { requireScope(args); reply.complete(documents.previewRecovery(args.getString("id")), null); }
                    case "recovery.restore" -> { ensureEngineIdle(); requireScope(args); JSONObject restore = documents.recoveryMutation(args.getString("id")); mutate(restore.getString("operation"), restore.getJSONObject("arguments"), true, reply); }
                    case "changes.list" -> { requireScope(args); reply.complete(changes.list(reviewDirectory()), null); }
                    case "changes.history" -> { requireScope(args); reply.complete(obj("entries", changes.history(reviewDirectory())), null); }
                    case "changes.preview" -> { requireScope(args); reply.complete(changes.preview(reviewDirectory(), args.getString("path")), null); }
                    case "changes.backupPreview" -> { requireScope(args); reply.complete(changes.previewBackup(reviewDirectory(), args.getString("id")), null); }
                    case "changes.restore" -> {
                        ensureEngineIdle(); requireScope(args);
                        if (permissionMode.equals("read-only")) throw new IOException(t("읽기 전용 모드에서는 복원할 수 없습니다."));
                        if (terminal.busy()) throw new IOException(t("실행 중인 터미널 명령을 먼저 중지해 주세요."));
                        JSONObject result = changes.restore(reviewDirectory(), args.getString("token")); event("files.changed", result); reply.complete(result, null);
                    }
                    case "projects.select" -> { documents.selectProject(args.optString("key", "")); clearActive(); completeNavigation(navigation, reply); }
                    case "projects.remove" -> {
                        String key = args.getString("key");
                        ensureProjectIdle(key);
                        boolean activeProjectRemoved = active != null && key.equals(active.optString("workspaceKey"));
                        JSONArray replacement = new JSONArray(sessions.toString()); int moved = moveSessionsToGeneral(replacement, key);
                        if (moved > 0) backupSessionsForProjectRemoval(sessions.toString());
                        JSONObject removed = documents.removeProject(key);
                        if (moved > 0) {
                            try { persistSessions(replacement); }
                            catch (IOException error) {
                                // The durable project tombstone is itself the recovery journal:
                                // startup will idempotently generalize the still-intact sessions file.
                                replaceSessions(replacement); if (activeProjectRemoved) serverThreadId = ""; syncCurrentTurn(); publish();
                                throw new IOException(t("프로젝트 연결은 해제됐지만 대화 기록 저장을 마치지 못했습니다. 대화는 보존되며 앱을 다시 시작하면 일반 대화 이전을 재시도합니다."), error);
                            }
                            replaceSessions(replacement); if (activeProjectRemoved) serverThreadId = ""; syncCurrentTurn();
                        }
                        publish();
                        removed.put("movedChats", moved).put("workspace", documents.workspace());
                        reply.complete(removed, null);
                    }
                    case "projects.rename" -> { JSONObject renamed = documents.renameProject(args.getString("key"), args.getString("name")); publish(); reply.complete(renamed, null); }
                    case "projects.export" -> reply.complete(documents.exportProject(args.getString("key")), null);
                    case "projects.import.preview" -> reply.complete(documents.previewProjects(args.getString("content")), null);
                    case "projects.import.apply" -> { ensureEngineIdle(); JSONObject imported = documents.importProjects(args.getString("content"), args.getString("token")); publish(); reply.complete(imported, null); }
                    case "projects.workspaceFolders" -> reply.complete(documents.workspaceFolders(args.optString("path")), null);
                    case "projects.create", "projects.bindWorkspaceFolder", "projects.createWorkspaceFolder" -> {
                        if (action.equals("projects.createWorkspaceFolder") && permissionMode.equals("read-only"))
                            throw new IOException(t("현재 읽기 전용 모드입니다. 권한 설정을 변경해 주세요."));
                        boolean select = canOpenNewProject();
                        JSONObject created = switch (action) {
                            case "projects.create" -> documents.createProject(args.getString("name"), select);
                            case "projects.bindWorkspaceFolder" -> documents.bindWorkspaceFolder(args.getString("path"), select);
                            default -> documents.createWorkspaceFolder(args.optString("path"), args.getString("name"), select);
                        };
                        if (select) clearActive();
                        publish(); reply.complete(created, null);
                    }
                    case "projects.merge" -> { ensureEngineIdle(); JSONObject merged = documents.mergeProjects(args.getString("sourceKey"), args.getString("targetKey")); publish(); reply.complete(merged, null); }
                    case "projects.prefer" -> { ensureEngineIdle(); JSONObject result = documents.preferProject(args.getString("key")); publish(); reply.complete(result, null); }
                    case "documents.projects" -> reply.complete(obj("projects", documents.projects()), null);
                    case "chat.send" -> { requireChatScope(args);
                        startingTurn = true;
                        try { syncTaskCpu(); send(args.optString("text", ""), args.optString("model", ""), args.optString("effort", ""),
                        args.optJSONArray("attachments"), args.optJSONArray("skills"), args.optJSONArray("mentions"),
                        args.has("fastMode") ? args.getBoolean("fastMode") : null); }
                        finally { startingTurn = false; syncTaskCpu(); }
                        reply.complete(obj("ok", true), null); }
                    case "chat.history" -> reply.complete(history(args), null);
                    case "chat.steer" -> { steer(args); reply.complete(obj("ok", true), null); }
                    case "chat.new" -> {
                        String key = args.has("workspaceKey") ? args.optString("workspaceKey", "") : documents.key();
                        documents.selectProject(key); clearActive(); completeNavigation(navigation, reply);
                    }
                    case "chat.resume" -> { resume(args.getString("id"), navigation); completeNavigation(navigation, reply); }
                    case "chat.move" -> { moveSession(args.getString("id"), args.getString("key")); publish(); reply.complete(snapshot(), null); }
                    case "chat.rename" -> { renameSession(args.getString("id"), args.getString("title")); publish(); reply.complete(snapshot(), null); }
                    case "chat.delete" -> {
                        boolean deletionPending = deleteSession(args.getString("id"));
                        publish();
                        JSONObject result = snapshot(); result.put("deletionPending", deletionPending);
                        reply.complete(result, null);
                    }
                    case "chat.stop" -> {
                        if (!turnId.isEmpty()) call("turn/interrupt", obj("threadId", activeCodexThreadId(), "turnId", turnId));
                        if (pendingApproval != null) pendingApproval.decision.complete(false);
                        reply.complete(obj("ok", true), null);
                    }
                    default -> throw new IOException(t("지원하지 않는 요청입니다: ") + action);
                }
            } catch (Throwable e) {
                publishDiagnostic(DiagnosticFailure.snapshot(e, diagnosticOperation), action);
                reply.complete(null, unwrap(e));
            } finally {
                diagnosticOperation = previousOperation;
            }
        });
    }
    private static Throwable unwrap(Throwable e) {
        while ((e instanceof ExecutionException || e instanceof CompletionException) && e.getCause() != null) e = e.getCause();
        return e;
    }
    public void workspaceChanged() {
        io.execute(() -> { clearActive(); publish(); });
    }
    /** Runs folder binding on the engine queue. Only changes to existing bindings need idle. */
    JSONObject selectProjectFolder(Uri uri, String projectKey) throws Exception {
        boolean reconnect = projectKey != null && !projectKey.isBlank();
        if (reconnect) ensureEngineIdle();
        boolean select = reconnect || canOpenNewProject();
        JSONObject workspace = documents.select(uri, projectKey, select);
        if (select) clearActive();
        publish();
        return workspace;
    }
    private boolean canOpenNewProject() {
        return !busy && !hasRunningTurns() && (pendingApproval == null || pendingApproval.decision.isDone());
    }
    private void syncCurrentTurn() {
        turnId = runningTurns.getOrDefault(threadId, "");
        busy = !turnId.isBlank();
        status = busy ? t("작업 중") : (ready ? t("연결됨") : status);
    }
    private void clearActive() {
        active = null; threadId = ""; turnId = ""; serverThreadId = ""; busy = false;
        draftProviderId = apiProviders.activeId();
        activateChatRuntime();
        if (ready) status = t("연결됨");
    }
    public boolean isBusy() { return busy; }
    private boolean hasRunningTurns() { return !runningTurns.isEmpty(); }
    private void ensureSessionIdle(String id) throws IOException {
        if (runningTurns.containsKey(id) || (id.equals(threadId) && busy)) throw new IOException(t("현재 대화의 작업을 먼저 중지해 주세요."));
    }
    private void ensureProjectIdle(String key) throws IOException {
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject target = sessions.optJSONObject(i);
            if (target != null && key.equals(target.optString("workspaceKey"))) ensureSessionIdle(target.optString("id"));
        }
    }
    private void ensureEngineIdle() throws IOException {
        if (hasRunningTurns()) throw new IOException(t("진행 중인 작업을 먼저 중지해 주세요."));
        if (pendingApproval != null && !pendingApproval.decision.isDone()) throw new IOException("请先处理当前审批。");
    }
    private void ensureRuntimeSettingsIdle() throws IOException {
        ensureEngineIdle();
        if (terminal.busy()) throw new IOException(t("터미널 명령을 마친 뒤 Linux 설정을 변경해 주세요."));
        if (linux.status().optBoolean("busy")) throw new IOException(t("Linux 설치 작업을 마친 뒤 다시 시도해 주세요."));
    }
    private void linuxChanged() {
        if (io.isShutdown()) return;
        io.execute(() -> { event("linux.changed", linux.status()); syncTaskCpu(); stopServiceIfIdle(); });
    }
    private void stopServiceIfIdle() {
        if (!hasForegroundWork()) context.stopService(new Intent(context, EngineService.class));
    }
    boolean hasForegroundWork() {
        return startingTurn || !runningTurns.isEmpty() || terminal.busy() || linux.status().optBoolean("busy");
    }
    void reconcileService() {
        if (!io.isShutdown()) io.execute(() -> {
            recoverRememberedRuntime(false);
            stopServiceIfIdle();
        });
    }
    private boolean inProviderScope(JSONObject target, String scope) {
        return target != null && (testTransport != null && scope.isBlank() || scope.equals(target.optString("apiScope")));
    }
    private void clearRunningState(String scope) {
        boolean lostTurn = false;
        for (var turn : new HashMap<>(runningTurns).entrySet()) {
            JSONObject target = session(turn.getKey());
            if (!inProviderScope(target, scope)) continue;
            turnAgents.remove(turn.getKey());
            retryingStreams.remove(turn.getKey());
            turnProgress.remove(turn.getKey());
            runningTurns.remove(turn.getKey());
            try {
                target.remove("inFlightTurn");
                WorkHistory.finish(target.optJSONArray("messages"), turn.getValue());
                target.put("conversationFailure", obj("code", "runtime_disconnected", "turnId", turn.getValue()));
                lostTurn = true;
            } catch (org.json.JSONException ignored) { }
        }
        syncTaskCpu();
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject value = sessions.optJSONObject(i);
            if (inProviderScope(value, scope)) try { value.put("approvalPending", false); } catch (Exception ignored) {}
        }
        syncCurrentTurn();
        if (lostTurn) persist();
    }
    private void start() throws Exception {
        start(true);
    }
    /** Preparing the API runtime does not change saved conversations. */
    private void start(boolean restoreConversation) throws Exception {
        StartupDiagnostics diagnostic = new StartupDiagnostics();
        RuntimeFailure.Tail stderrTail = new RuntimeFailure.Tail();
        boolean replacing = false, spawnAttempted = false;
        try {
            diagnostic.stage("runtime_prepare");
            if (testTransport != null) {
                ready = true;
                if (restoreConversation) restoreConversation();
                rememberRuntime();
                return;
            }
            if (healthyTransport()) {
                if (restoreConversation) retryPendingDeletions();
                publish();
                return;
            }
            // A stdout disconnect can race with queued UI RPCs. Never reuse its closed writer or
            // leave the old child around while replacing it.
            replacing = true;
            Process staleProcess = process; RpcClient staleRpc = rpc;
            process = null; rpc = null; ready = false;
            // Loaded thread ids and running turns belong to the old transport. A queued
            // disconnect callback is ignored after replacement, so invalidate them here
            // before restoreConversation() can mistake a saved id for a loaded thread.
            serverThreadId = "";
            clearRunningState(runtimeScope);
            if (staleRpc != null) staleRpc.close();
            if (staleProcess != null && staleProcess.isAlive()) staleProcess.destroyForcibly();
            if (!providerAvailable()) throw new IOException("该聊天绑定的 API 服务商不可用，请检查设置。");
            String launchScope = runtimeScope;
            JSONObject profile = apiProviders.profileDetails(providerId());
            processHome = apiProviders.prepareHome(codexHome.root(), providerId());
            refreshApiState();
            diagnostic.stage("runtime_check");
            if (!Arrays.asList(Build.SUPPORTED_ABIS).contains("arm64-v8a"))
                throw new IOException(t("이 알파 버전은 ARM64 안드로이드 기기용입니다."));
            File libraryDir = new File(context.getApplicationInfo().nativeLibraryDir);
            File binary = new File(libraryDir, "libcodex.so");
            if (!binary.isFile() || !binary.canExecute()) throw new IOException(t("실행 엔진이 포함되지 않았습니다. 전체 APK를 다시 설치해 주세요."));
            status = t("Codex를 시작하고 있습니다"); publish();
            // Keep upstream Codex tools/features available; preserve user configuration.
            diagnostic.stage("config_prepare");
            File config = new File(processHome, "config.toml");
            installUltraCatalog(config, profile);
            ProcessBuilder builder = new ProcessBuilder(binary.getAbsolutePath(), "app-server", "--listen", "stdio://",
                "-c", "model_provider=" + ApiProviderPolicy.quote(ApiProviderPolicy.PROVIDER_ID),
                "-c", "model=" + ApiProviderPolicy.quote(profile.optString("defaultModel")));
            diagnostic.stage("environment_prepare");
            builder.directory(projectDirectory());
            devTools.configure(builder, processHome, runtimeAliases());
            // Retire the app-owned Pro bridge left in old configurations. Only disable an entry
            // that exists: Codex rejects an MCP server that has no transport and will not start.
            if (retiredProBridgeConfigured(config)) builder.command().addAll(List.of("-c", "mcp_servers.mobile_codex_pro.enabled=false"));
            linux.configureEnvironment(builder.environment());
            builder.environment().remove("OPENAI_API_KEY"); builder.environment().remove("OPENAI_BASE_URL");
            builder.environment().remove("OPENAI_API_BASE"); builder.environment().remove("CODEX_API_KEY");
            builder.environment().remove("MOBILE_CODEX_CUSTOM_API_KEY");
            builder.environment().put(ApiProviderPolicy.KEY_ENV, apiProviders.key(providerId()));
            builder.environment().put("CODEX_SELF_EXE", binary.getAbsolutePath());
            diagnostic.stage("before_spawn");
            spawnAttempted = true;
            process = builder.start();
            diagnostic.spawned();
            Process launched = process;
            Thread errors = new Thread(() -> {
                // Drain stderr to avoid deadlock. Keep only a bounded private tail for allow-listed diagnostics.
                try (InputStream stderr = launched.getErrorStream()) { byte[] buffer = new byte[4096]; int count; while ((count = stderr.read(buffer)) != -1) { diagnostic.stderr(count); stderrTail.append(buffer, count); } }
                catch (IOException ignored) {}
            }, "codex-stderr"); errors.setDaemon(true); errors.start();
            final RpcClient[] launchedConnection = new RpcClient[1];
            rpc = new RpcClient(process.getInputStream(), process.getOutputStream(), new RpcClient.Listener() {
                @Override public void notification(String method, JSONObject params) {
                    io.execute(() -> withProviderEvent(launchScope, launched, launchedConnection[0], () -> onNotification(method, params)));
                }
                @Override public void request(Object id, String method, JSONObject params) {
                    io.execute(() -> withProviderEvent(launchScope, launched, launchedConnection[0], () -> onRequest(launchedConnection[0], id, method, params)));
                }
                @Override public void disconnected(Throwable error) {
                    io.execute(() -> withProviderEvent(launchScope, launched, launchedConnection[0], () -> {
                        if (launchScope.equals(runtimeScope)) codexDisconnected(launched, launchedConnection[0], error, stderrTail);
                        else { retireProviderRuntime(launchScope); publish(); stopServiceIfIdle(); }
                    }));
                }
            }, diagnostic);
            launchedConnection[0] = rpc;
            rpc.start();
            diagnostic.initializing();
            call("initialize", obj("clientInfo", obj("name", "mobile_codex", "title", "Mobile Codex", "version", "0.1.11"),
                "capabilities", obj("experimentalApi", true)));
            diagnostic.initialized();
            rpc.notify("initialized", new JSONObject());
            ready = true; status = t("연결됨");
            refreshApiState();
            diagnostic.stage("conversation_restore");
            if (restoreConversation) restoreConversation();
            diagnostic.ready();
            rememberRuntime();
            publish();
        } catch (Exception e) {
            // Keep nested measurements from this exact operation, not a recovery attempt.
            if (e instanceof DiagnosticFailure) throw e;
            Process failed = process; int exitCode = -1;
            try { if (failed != null) exitCode = failed.exitValue(); } catch (IllegalThreadStateException ignored) { }
            String errorCode = DiagnosticFailure.snapshot(e, diagnosticOperation).optString("errorCode", "start_failure");
            if ("operation_failed".equals(errorCode)) errorCode = "start_failure";
            if ("initialize_sent".equals(diagnostic.stage()) && unwrap(e) instanceof TimeoutException) errorCode = "initialize_timeout";
            JSONObject measured = diagnostic.snapshot(errorCode, apiProviders.configured() ? "active" : "unknown", failed != null && failed.isAlive(), exitCode, stderrTail.category());
            String diagnosis = stderrTail.diagnosis();
            String detail = t("Codex를 시작하지 못했습니다") + (exitCode >= 0 ? t(" (종료 코드 ") + exitCode + ")" : "") + ": " + unwrap(e).getMessage()
                + (diagnosis.isEmpty() ? "" : t(" (진단 단서: ") + diagnosis + ")");
            // Pre-launch failures previously reached callers unchanged. Diagnostics
            // must not alter their user-facing message or recovery contract.
            if (!spawnAttempted) detail = unwrap(e).getMessage();
            if (replacing) retireProviderRuntime(runtimeScope);
            throw new DiagnosticFailure(detail, e, diagnosticOperation, measured);
        }
    }
    private void withProviderEvent(String scope, Process launched, RpcClient connection, Runnable action) {
        ParkedRuntime parked = parkedRuntimes.get(scope);
        boolean visible = scope.equals(runtimeScope) && process == launched && rpc == connection;
        if (!visible && (parked == null || parked.process != launched || parked.connection != connection)) return;
        String previousScope = eventScope;
        eventScope = scope;
        try { action.run(); } finally { eventScope = previousScope; }
    }
    private void restoreConversation() throws Exception {
        // Retry tombstones only in the conversation's HOME, before resuming it.
        retryPendingDeletions();
        if (active != null && sessionProviderMatches(active) && active.optString("workspaceKey").equals(documents.key()) && documents.workspace().optBoolean("available")) resumeRemote(false);
    }
    void codexDisconnected(Process launched, RpcClient connection, Throwable error, RuntimeFailure.Tail stderrTail) {
        if (process != launched || rpc != connection) return;
        int exitCode = -1;
        try { exitCode = launched.exitValue(); } catch (IllegalThreadStateException ignored) { }
        publishDiagnostic(obj("errorCode", "transport_closed", "stage", "running", "homeKind", apiProviders.configured() ? "active" : "unknown",
            "processAlive", launched.isAlive(), "exitCode", exitCode, "stderrCategory", stderrTail.category()),
            hasRunningTurns() ? "chat.send" : "runtime.start");
        if (launched.isAlive()) launched.destroyForcibly();
        if (connection != null && !connection.isClosed()) connection.close();
        PhoneUseService.stopControl();
        process = null; rpc = null;
        clearRequests(connection);
        ready = false; clearRunningState(runtimeScope); serverThreadId = "";
        String detail = error == null ? t("Codex 연결이 종료되었습니다.") : error.getMessage();
        String diagnosis = stderrTail.diagnosis();
        status = t("실행 엔진 연결이 종료되었습니다") + (exitCode >= 0 ? t(" (종료 코드 ") + exitCode + ")" : "") + ". " + detail
            + (diagnosis.isEmpty() ? "" : t(" 진단 단서: ") + diagnosis + ".") + t(" 다시 연결해 주세요.");
        if (pendingApproval != null) pendingApproval.decision.complete(false);
        publish();
        recoverRememberedRuntime(false);
        stopServiceIfIdle();
    }
    private JSONObject call(String method, JSONObject params) throws Exception { return call(method, params, 65); }
    private JSONObject call(String method, JSONObject params, int timeoutSeconds) throws Exception {
        if (testTransport != null) return testTransport.call(method, params);
        if (rpc == null) throw new IOException(t("먼저 Codex를 시작해 주세요."));
        return rpc.request(method, params).get(timeoutSeconds, TimeUnit.SECONDS);
    }
    private String resolvedModel(String requested) {
        if (requested != null && !requested.isBlank()) return requested;
        for (int i = 0; i < models.length(); i++) {
            JSONObject model = models.optJSONObject(i);
            if (model != null && model.optBoolean("isDefault")) return model.optString("model", model.optString("id"));
        }
        if (providerAvailable()) try { return apiProviders.profileDetails(providerId()).optString("defaultModel"); } catch (IOException ignored) {}
        return "";
    }
    /** Catalog-driven Fast selection. Do not infer support from a model id or display name. */
    private String fastServiceTier(String model) throws IOException {
        JSONObject selected = null;
        for (int i = 0; i < models.length(); i++) {
            JSONObject candidate = models.optJSONObject(i);
            if (candidate != null && (model.equals(candidate.optString("model")) || model.equals(candidate.optString("id")))) {
                selected = candidate; break;
            }
        }
        if (selected != null) {
            JSONArray tiers = selected.optJSONArray("serviceTiers");
            for (String desired : new String[]{"fast", "priority"}) {
                if (tiers != null) for (int i = 0; i < tiers.length(); i++) {
                    JSONObject tier = tiers.optJSONObject(i);
                    if (tier != null && desired.equals(tier.optString("id"))) return desired;
                }
            }
            JSONArray legacy = selected.optJSONArray("additionalSpeedTiers");
            for (String desired : new String[]{"fast", "priority"}) {
                if (legacy != null) for (int i = 0; i < legacy.length(); i++)
                    if (desired.equals(legacy.optString(i))) return desired;
            }
        }
        throw new IOException(t("선택한 모델에서는 Fast 모드를 지원하지 않습니다."));
    }
    private String workspaceInstructions(String model) {
        JSONObject workspace = documents.workspace();
        return ToolCatalog.INSTRUCTIONS + " Selected Android folder: " + workspace.optString("name", "none")
            + ". Folder available: " + workspace.optBoolean("available") + ". Direct shell access to that folder: "
            + (documents.directDirectory() != null) + ". The exact model requested for this thread is "
            + (model == null || model.isBlank() ? "not available from the runtime" : model)
            + ". When the user asks which model you are, report that exact requested model id."
            + " Current app GitHub login: " + githubAuth.agentStatus()
            + ". GitHub permissions cover public repositories and workflows; private repository access is not granted."
            + " After using tools, send a final reply stating what actually happened. For file work, briefly report the deliverable, its verified name and location, and what you checked and the result."
            + " Say which relevant checks were skipped or could not be run. Respect requests to skip a check, and never report an unrun check as passed."
            + linuxInstructions(linux.status());
    }
    static String linuxInstructions(JSONObject state) {
        if (!state.optBoolean("installed") || !state.optBoolean("enabled"))
            return " Optional Linux development environment is disabled. Do not download or enable it automatically. The user can install and enable it in Settings > Tools.";
        return " Optional Arch Linux ARM64 environment is enabled. When a required tool is missing or unsupported on Android, check Linux readiness with `mc-linux status`. "
            + "Use the existing shell tool with `mc-linux -- /bin/bash -lc 'command'` to check for required tools and run the task in Linux. "
            + "It uses the shell's current working directory as /workspace in Linux, so change the host working directory to the requested project first. Files in /workspace are the same project files. "
            + "Linux packages and /root persist separately from the Android toolchain. Check available commands before assuming a compiler or package is installed. "
            + "Use the normal approval policy for Linux commands and package installations. PRoot does not grant Android root or provide a security sandbox. "
            + "Host credentials are not automatically available inside Linux. Do not copy them to work around login requirements. Model inference remains online.";
    }
    private String approvalPolicy() { return "allow-all".equals(approvalMode) ? "never" : "on-request"; }
    private String approvalsReviewer() { return "auto-review".equals(approvalMode) ? "auto_review" : "user"; }
    private JSONObject threadStartParams(String model) throws Exception {
        model = resolvedModel(model);
        JSONObject params = obj("cwd", projectDirectory().getAbsolutePath(), "sandbox", permissionMode, "approvalPolicy", approvalPolicy(), "approvalsReviewer", approvalsReviewer(),
            "developerInstructions", workspaceInstructions(model), "dynamicTools", ToolCatalog.all());
        if (providerAvailable()) params.put("modelProvider", ApiProviderPolicy.PROVIDER_ID);
        if (!model.isEmpty()) params.put("model", model);
        return params;
    }
    private String codexThreadId(JSONObject session) {
        if (session == null) return "";
        if (session.has("codexThreadId")) return session.optString("codexThreadId");
        return session.has("sessionVersion") ? "" : session.optString("id");
    }
    private boolean sessionProviderMatches(JSONObject session) {
        if (session == null) return true;
        if (testTransport != null && !providerAvailable()) return providerScope().isBlank();
        return providerAvailable() && providerScope().equals(session.optString("apiScope"));
    }
    private void requireSessionProvider(JSONObject session) throws IOException {
        if (!sessionProviderMatches(session)) throw new IOException("该聊天的 API 绑定已失效，请重新绑定服务商。");
    }
    private String activeCodexThreadId() { return codexThreadId(active); }
    private JSONObject sessionByCodexThreadId(String remoteId) {
        return sessionByCodexThreadId(remoteId, eventScope.isBlank() ? providerScope() : eventScope);
    }
    private JSONObject sessionByCodexThreadId(String remoteId, String scope) {
        if (remoteId == null || remoteId.isBlank()) return null;
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject value = sessions.optJSONObject(i);
            if (inProviderScope(value, scope) && remoteId.equals(codexThreadId(value))) return value;
        }
        return null;
    }
    private String localIdForCodexThread(String remoteId) {
        JSONObject value = sessionByCodexThreadId(remoteId);
        return value == null ? "" : value.optString("id");
    }
    /** thread/resume schema accepts cwd and instructions but not dynamicTools. */
    private void resumeRemote(boolean force) throws Exception { resumeRemote(force, active == null ? "" : active.optString("model")); }
    private void resumeRemote(boolean force, String model) throws Exception {
        String remoteId = activeCodexThreadId();
        requireSessionProvider(active);
        if (active == null || remoteId.isEmpty()) return;
        String currentInstructions = workspaceInstructions(resolvedModel(model));
        if (!force && remoteId.equals(serverThreadId) && currentInstructions.equals(serverInstructions)) return;
        if (!active.optString("workspaceKey").equals(documents.key()))
            throw new IOException(t("이 대화의 원래 작업 폴더를 다시 연결해 주세요."));
        documents.requireWorkspaceAvailable();
        call("thread/resume", obj("threadId", remoteId, "excludeTurns", true, "cwd", projectDirectory().getAbsolutePath(),
            "sandbox", permissionMode, "approvalPolicy", approvalPolicy(), "approvalsReviewer", approvalsReviewer(), "developerInstructions", currentInstructions));
        serverThreadId = remoteId;
        serverInstructions = currentInstructions;
        restoreWorkHistory();
    }
    private void restoreWorkHistory() {
        if (active == null || (active.optInt("imageHistoryVersion") >= 1 && active.optInt("workHistoryVersion") >= 1)) return;
        try {
            String remoteId = activeCodexThreadId();
            if (remoteId.isBlank()) return;
            JSONObject thread = call("thread/read", obj("threadId", remoteId, "includeTurns", true)).optJSONObject("thread");
            JSONArray turns = thread == null ? null : thread.optJSONArray("turns");
            if (turns == null) return;
            if (active.optInt("workHistoryVersion") < 1) WorkHistory.restore(active.getJSONArray("messages"), turns);
            for (int t = 0; active.optInt("imageHistoryVersion") < 1 && t < turns.length(); t++) {
                JSONObject turn = turns.optJSONObject(t); if (turn == null) continue;
                JSONArray items = turn.optJSONArray("items");
                if (items != null) for (int n = 0; n < items.length(); n++) {
                    JSONObject item = items.optJSONObject(n); if (item != null) recordImages(item, true, turn.optString("id"));
                }
            }
            active.put("imageHistoryVersion", 1).put("workHistoryVersion", 1); persist(); publish();
        } catch (Exception e) {
            event("notice", obj("message", t("이전 이미지 기록을 불러오지 못했습니다: ") + unwrap(e).getMessage()));
        }
    }
    private JSONArray input(String text, JSONArray attachmentIds, JSONArray skills, JSONArray mentions) throws Exception {
        JSONArray result = new JSONArray();
        if (!text.isBlank()) result.put(obj("type", "text", "text", text, "text_elements", new JSONArray()));
        addSkills(result, skills);
        addMentions(result, mentions);
        JSONArray attachmentsInput = attachments.inputs(attachmentIds);
        for (int i = 0; i < attachmentsInput.length(); i++) {
            JSONObject value = attachmentsInput.getJSONObject(i);
            if ("text".equals(value.optString("type")) && !value.has("text_elements")) value.put("text_elements", new JSONArray());
            result.put(value);
        }
        return result;
    }
    private void addSkills(JSONArray result, JSONArray skills) throws Exception {
        if (skills == null) return;
        if (skills.length() > 32) throw new IOException(t("한 메시지에는 최대 32개의 스킬을 추가할 수 있습니다."));
        HashSet<String> seen = new HashSet<>();
        for (int i = 0; i < skills.length(); i++) {
            JSONObject value = skills.optJSONObject(i); if (value == null) throw new IOException(t("스킬 정보가 올바르지 않습니다."));
            String name = value.optString("name"), path = value.optString("path");
            if (name.isBlank() || path.isBlank() || !seen.add(path)) throw new IOException(t("스킬 정보가 올바르지 않습니다."));
            result.put(obj("type", "skill", "name", name, "path", path));
        }
    }
    private void addMentions(JSONArray result, JSONArray mentions) throws Exception {
        if (mentions == null) return;
        if (mentions.length() > 64) throw new IOException(t("한 메시지에는 최대 64개의 멘션을 추가할 수 있습니다."));
        HashSet<String> seen = new HashSet<>();
        for (int i = 0; i < mentions.length(); i++) {
            JSONObject value = mentions.optJSONObject(i); if (value == null) throw new IOException(t("멘션 정보가 올바르지 않습니다."));
            String name = value.optString("name"), path = value.optString("path");
            if (name.isBlank() || path.isBlank() || !seen.add(path)) throw new IOException(t("멘션 정보가 올바르지 않습니다."));
            if (path.startsWith("app://") || path.startsWith("plugin://")) result.put(obj("type", "mention", "name", name, "path", path));
            else if (new File(path).isAbsolute()) {
                File file = new File(path).getCanonicalFile();
                if (!file.isFile() || !allowedMentionFile(file)) throw new IOException(t("멘션 파일을 읽을 수 없습니다."));
                result.put(obj("type", "mention", "name", name, "path", file.getAbsolutePath()));
                result.put(obj("type", "text", "text", "Mentioned file is available at this absolute path: " + file.getAbsolutePath(), "text_elements", new JSONArray()));
            }
            else {
                JSONObject file = documents.mention(path, attachments);
                result.put(obj("type", "mention", "name", file.getString("name"), "path", file.getString("path")));
                result.put(obj("type", "text", "text", "Mentioned file is available at this absolute path: " + file.getString("path"), "text_elements", new JSONArray()));
            }
        }
    }
    private boolean allowedMentionFile(File file) throws IOException {
        File privateAttachments = new File(context.getFilesDir(), "attachments").getCanonicalFile();
        if (file.getPath().startsWith(privateAttachments.getPath() + File.separator)) return true;
        File workspace = documents.directDirectory();
        return workspace != null && file.getPath().startsWith(workspace.getCanonicalPath() + File.separator);
    }
    private String titleFor(String text, JSONArray attachmentIds) {
        if (!text.isBlank()) return text.substring(0, Math.min(40, text.length()));
        if (attachmentIds != null && attachmentIds.length() > 0) return t("첨부 파일 ") + attachmentIds.length() + t("개");
        return t("제목 없는 대화");
    }
    private String sessionWorkspaceName() {
        return documents.key().isBlank() ? "" : documents.workspace().optString("name");
    }
    private JSONObject userMessage(String text, JSONArray attachmentIds, JSONArray skills, JSONArray mentions) throws Exception {
        JSONObject message = obj("role", "user", "text", text, "id", UUID.randomUUID().toString(), "createdAt", System.currentTimeMillis());
        if (skills != null && skills.length() > 0) message.put("skills", new JSONArray(skills.toString()));
        if (mentions != null && mentions.length() > 0) message.put("mentions", new JSONArray(mentions.toString()));
        if (attachmentIds != null && attachmentIds.length() > 0) {
            JSONArray stored = new JSONArray();
            HashSet<String> seen = new HashSet<>();
            for (int i = 0; i < attachmentIds.length(); i++) {
                String id = attachmentIds.getString(i);
                if (seen.add(id)) stored.put(attachments.get(id));
            }
            message.put("attachments", stored);
        }
        return message;
    }
    private void requireScope(JSONObject args) throws IOException {
        if (!args.has("workspaceKey") || !args.optString("workspaceKey").equals(documents.key())) throw new IOException(t("프로젝트가 바뀌었습니다. 다시 열어 주세요."));
    }
    private void requireFileScope(JSONObject args) throws IOException {
        // Older packaged UIs omitted this field. Scoped requests must match before any I/O.
        if (args.has("workspaceKey")) requireScope(args);
    }
    private void requireChatScope(JSONObject args) throws IOException {
        if (args.has("expectedThreadId") && !args.optString("expectedThreadId").equals(threadId)) throw new IOException(t("대화가 바뀌었습니다. 현재 대화에서 다시 보내 주세요."));
        if (args.has("expectedApiScope") && !args.optString("expectedApiScope").equals(providerScope()))
            throw new IOException("聊天的 API 服务商已切换，请重新发送。");
        if (args.has("workspaceKey")) requireScope(args);
    }
    /** Fetch older local display history without exposing another thread or an overlapping cursor item. */
    private JSONObject history(JSONObject args) throws IOException {
        // JSONObject#getString throws checked JSONException. Validate the wire
        // shape explicitly so malformed/stale requests take the normal RPC
        // error path and this helper remains an IOException-only boundary.
        Object rawThread = args.opt("threadId");
        Object rawBeforeId = args.opt("beforeId");
        if (!(rawThread instanceof String) || !(rawBeforeId instanceof String))
            throw new IOException(t("이전 메시지 위치가 오래되었습니다. 대화를 다시 열어 주세요."));
        String requestedThread = (String) rawThread;
        String beforeId = (String) rawBeforeId;
        if (requestedThread.isBlank() || beforeId.isBlank() || active == null || !requestedThread.equals(threadId)
                || !requestedThread.equals(active.optString("id")))
            throw new IOException(t("대화가 바뀌었습니다. 현재 대화를 다시 열어 주세요."));
        JSONObject stored = session(requestedThread);
        if (stored == null || stored.optBoolean("deletionPending")) throw new IOException(t("대화를 찾을 수 없습니다."));
        JSONArray messages = stored.optJSONArray("messages");
        if (messages == null) messages = new JSONArray();
        int cursor = -1;
        for (int i = 0; i < messages.length(); i++) {
            JSONObject message = messages.optJSONObject(i);
            if (message != null && beforeId.equals(message.optString("id"))) {
                if (cursor >= 0) throw new IOException(t("이전 메시지 위치가 오래되었습니다. 대화를 다시 열어 주세요."));
                cursor = i;
            }
        }
        if (cursor < 0) throw new IOException(t("이전 메시지 위치가 오래되었습니다. 대화를 다시 열어 주세요."));
        int requestedLimit = args.has("limit") ? args.optInt("limit", SNAPSHOT_MESSAGE_LIMIT) : SNAPSHOT_MESSAGE_LIMIT;
        int limit = Math.max(1, Math.min(SNAPSHOT_MESSAGE_LIMIT, requestedLimit));
        int start = Math.max(0, cursor - limit);
        JSONArray page = new JSONArray();
        for (int i = start; i < cursor; i++) page.put(uiJsonCopy(messages.opt(i)));
        return obj("threadId", requestedThread, "messages", page, "messageHistory", messageHistory(messages, start));
    }
    private void steer(JSONObject args) throws Exception {
        requireChatScope(args);
        String text = args.optString("text").trim();
        if (text.isEmpty() || text.length() > 50000) throw new IOException(t("추가 지시는 1~50,000자로 입력해 주세요."));
        if (!busy || turnId.isEmpty() || !turnId.equals(args.optString("expectedTurnId"))) throw new IOException(t("진행 중인 작업이 변경되거나 종료되었습니다. 새 메시지로 보내 주세요."));
        JSONArray input = input(text, args.optJSONArray("attachments"), args.optJSONArray("skills"), args.optJSONArray("mentions"));
        String remoteId = activeCodexThreadId();
        if (remoteId.isBlank()) throw new IOException(t("이 대화에는 진행 중인 Codex 작업이 없습니다."));
        call("turn/steer", obj("threadId", remoteId, "expectedTurnId", turnId, "input", input));
        JSONObject message = userMessage(text, args.optJSONArray("attachments"), args.optJSONArray("skills"), args.optJSONArray("mentions"));
        active.getJSONArray("messages").put(message);
        persist(); publish();
    }
    private File reviewDirectory() throws IOException {
        documents.requireWorkspaceAvailable();
        if (documents.workspace().optBoolean("selected") && documents.directDirectory() == null) throw new IOException(t("이 폴더는 문서 제공자 전용입니다. 복구 사본에서 파일별 변경을 확인해 주세요."));
        return projectDirectory();
    }
    private byte[] git(File directory, List<String> arguments) throws Exception {
        File prefix = devTools.prepare();
        List<String> argv = new ArrayList<>(); argv.add(new File(prefix, "bin/git").getAbsolutePath()); argv.add("--no-pager"); argv.add("--literal-pathspecs"); argv.addAll(arguments);
        ProcessBuilder builder = new ProcessBuilder(argv).directory(directory);
        devTools.configure(builder, codexHome.root(), runtimeAliases()); builder.environment().put("GIT_OPTIONAL_LOCKS", "0"); builder.environment().put("GIT_TERMINAL_PROMPT", "0");
        return ProcessOutput.run(builder, 16 * 1024 * 1024, 15);
    }
    private void send(String text, String model, String effort, JSONArray attachmentIds, JSONArray skills, JSONArray mentions, Boolean fastMode) throws Exception {
        if (text.length() > 50000) throw new IOException(t("메시지는 최대 50,000자까지 입력할 수 있습니다."));
        documents.requireWorkspaceAvailable();
        JSONArray input = input(text, attachmentIds, skills, mentions);
        if (input.length() == 0) throw new IOException(t("메시지나 첨부 파일을 추가해 주세요."));
        start();
        requireSessionProvider(active);
        String actualModel = resolvedModel(model);
        // A supplied value applies to this new turn only. Omission deliberately
        // preserves legacy inheritance and does not alter a session preference.
        String serviceTierForTurn = fastMode == null ? null : (fastMode ? fastServiceTier(actualModel) : "default");
        JSONObject candidate = null;
        String candidateRemoteId = "", candidateLocalId = "";
        String candidateInstructions = "";
        if (active == null) {
            JSONObject params = threadStartParams(actualModel);
            JSONObject thread = call("thread/start", params).getJSONObject("thread");
            candidateInstructions = params.getString("developerInstructions");
            candidateRemoteId = thread.getString("id");
            candidateLocalId = "local-" + UUID.randomUUID();
            candidate = obj("id", candidateLocalId, "sessionVersion", 2, "codexThreadId", candidateRemoteId,
                "title", titleFor(text, attachmentIds), "workspace", sessionWorkspaceName(), "workspaceKey", documents.key(), "model", actualModel,
                "messages", new JSONArray(), "imageHistoryVersion", 1, "workHistoryVersion", 1, "phoneToolsVersion", 1, "fastMode", false, "apiScope", providerScope());
        } else {
            if (!active.optString("workspaceKey").equals(documents.key())) throw new IOException(t("이 대화의 원래 작업 폴더를 다시 연결해 주세요."));
            if (activeCodexThreadId().isBlank()) {
                JSONObject params = threadStartParams(actualModel);
                JSONObject thread = call("thread/start", params).getJSONObject("thread");
                candidateInstructions = params.getString("developerInstructions");
                candidateRemoteId = thread.getString("id");
            } else resumeRemote(!actualModel.equals(active.optString("model")), actualModel);
        }
        String targetLocal = candidate == null ? threadId : candidateLocalId;
        String targetRemote = candidateRemoteId.isBlank() ? activeCodexThreadId() : candidateRemoteId;
        busy = true; status = t("작업 중"); publish();
        try {
            JSONObject params = obj("threadId", targetRemote, "input", input, "cwd", projectDirectory().getAbsolutePath(), "approvalPolicy", approvalPolicy(), "approvalsReviewer", approvalsReviewer());
            if (!actualModel.isEmpty()) params.put("model", actualModel);
            if (!effort.isEmpty()) params.put("effort", "ultar".equalsIgnoreCase(effort) ? "ultra" : effort);
            params.put("summary", "auto");
            if (serviceTierForTurn != null) params.put("serviceTierForTurn", serviceTierForTurn);
            long turnStartedAt = System.currentTimeMillis();
            JSONObject turn = call("turn/start", params).optJSONObject("turn");
            if (candidate != null) { active = candidate; threadId = candidateLocalId; serverThreadId = candidateRemoteId; sessions.put(active); }
            else {
                active.put("model", actualModel);
                if (activeCodexThreadId().isBlank()) { active.put("codexThreadId", targetRemote); serverThreadId = targetRemote; }
            }
            if (!candidateInstructions.isEmpty()) serverInstructions = candidateInstructions;
            if (fastMode != null) active.put("fastMode", fastMode);
            active.remove("conversationFailure");
            JSONObject message = userMessage(text, attachmentIds, skills, mentions);
            active.getJSONArray("messages").put(message);
            if (turn != null) {
                String startedTurn = turn.optString("id", "");
                if (!startedTurn.isBlank()) trackTurn(targetLocal, startedTurn, turnStartedAt);
            }
            syncCurrentTurn();
            persist(); publish();
        } catch (Exception e) { syncCurrentTurn(); status = t("요청 실패"); publish(); throw e; }
    }
    private void resume(String id, long navigation) throws Exception {
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject session = sessions.getJSONObject(i);
            if (!session.optBoolean("deletionPending") && session.optString("id").equals(id)) {
                String key = session.optString("workspaceKey");
                try { documents.selectProject(key); }
                catch (Exception ignored) { documents.selectProject(""); }
                threadId = id; serverThreadId = ""; active = session; activateChatRuntime(); syncCurrentTurn();
                if (!busy && session.optInt("workHistoryVersion") < 1 && sessionProviderMatches(session) && !activeCodexThreadId().isBlank()) {
                    io.execute(() -> {
                        if (active != session || busy || (navigation != 0 && navigation != chatNavigation.get()) || !documents.workspace().optBoolean("available")) return;
                        try { start(false); restoreWorkHistory(); } catch (Exception ignored) { }
                    });
                }
                return;
            }
        }
        throw new IOException(t("대화를 찾을 수 없습니다."));
    }
    private void rebindSessionProvider(String id, String expectedThreadId, String expectedApiScope) throws Exception {
        if (active == null || !threadId.equals(expectedThreadId) || !providerScope().equals(expectedApiScope) || providerAvailable())
            throw new IOException("只能重新绑定 API 已失效的当前聊天。");
        ensureSessionIdle(threadId);
        apiProviders.key(id);
        String scope = apiProviders.scope(id);
        String model = apiProviders.profileDetails(id).getString("defaultModel");
        JSONArray replacement = new JSONArray(sessions.toString());
        for (int index = 0; index < replacement.length(); index++) {
            JSONObject session = replacement.getJSONObject(index);
            if (!threadId.equals(session.optString("id"))) continue;
            session.put("apiScope", scope).put("codexThreadId", "").put("model", model)
                .put("imageHistoryVersion", 1).put("workHistoryVersion", 1);
            persistSessions(replacement);
            replaceSessions(replacement);
            activateChatRuntime();
            syncCurrentTurn();
            return;
        }
        throw new IOException(t("대화를 찾을 수 없습니다."));
    }
    private void moveSession(String id, String key) throws Exception {
        ensureSessionIdle(id);
        JSONObject current = session(id);
        if (current == null || current.optBoolean("deletionPending")) throw new IOException(t("대화를 찾을 수 없습니다."));
        JSONArray projects = documents.projects(); JSONObject destination = null;
        for (int index = 0; index < projects.length(); index++) {
            JSONObject project = projects.getJSONObject(index);
            if (key.equals(project.getString("key"))) { destination = project; break; }
        }
        if (destination == null) throw new IOException("该项目已不存在，请重新选择。");
        JSONArray replacement = new JSONArray(sessions.toString());
        for (int index = 0; index < replacement.length(); index++) {
            JSONObject entry = replacement.getJSONObject(index);
            if (id.equals(entry.optString("id"))) { entry.put("workspaceKey", key).put("workspace", destination.optString("name")); break; }
        }
        persistSessions(replacement); replaceSessions(replacement);
        if (id.equals(threadId)) { serverThreadId = ""; documents.selectProject(key); syncCurrentTurn(); }
    }
    private void renameSession(String id, String title) throws Exception {
        // Titles are Mobile Codex local aliases: they remain available without starting or signing in to Codex.
        String trimmed = title.trim();
        if (trimmed.isEmpty()) throw new IOException(t("대화 제목을 입력해 주세요."));
        JSONArray replacement = new JSONArray(sessions.toString());
        boolean found = false;
        for (int i = 0; i < replacement.length(); i++) {
            JSONObject session = replacement.getJSONObject(i);
            if (!session.optBoolean("deletionPending") && session.optString("id").equals(id)) {
                session.put("title", trimmed);
                found = true;
                break;
            }
        }
        if (!found) throw new IOException(t("대화를 찾을 수 없습니다."));
        persistSessions(replacement);
        replaceSessions(replacement);
    }
    /**
     * First persist a hidden tombstone. This makes an offline request durable before any
     * server mutation. A connected runtime then deletes the real Codex thread immediately;
     * failed server calls leave the tombstone to retry on the next start/reconnect.
     */
    private boolean deleteSession(String id) throws Exception {
        ensureSessionIdle(id);
        boolean found = false;
        JSONArray marked = new JSONArray(sessions.toString());
        for (int i = 0; i < marked.length(); i++) {
            JSONObject session = marked.getJSONObject(i);
            if (!session.optBoolean("deletionPending") && session.optString("id").equals(id)) {
                session.put("deletionPending", true);
                found = true;
                break;
            }
        }
        if (!found) throw new IOException(t("대화를 찾을 수 없습니다."));
        // Do not clear the visible/active conversation until its pending-deletion record is durable.
        persistSessions(marked);
        replaceSessions(marked);
        JSONObject markedSession = session(id);
        String remoteId = codexThreadId(markedSession);
        boolean sameProvider = sessionProviderMatches(markedSession);
        boolean pending = !remoteId.isBlank() && !markedSession.optString("apiScope").isBlank()
            && (!sameProvider || !ready || !deleteRemote(remoteId, false));
        if (!remoteId.isBlank() && markedSession.optString("apiScope").isBlank() && sameProvider)
            pending = !ready || !deleteRemote(remoteId, false);
        if (id.equals(threadId)) clearActive();
        if (pending) return true;

        JSONArray remaining = withoutPendingSession(id);
        try {
            persistSessions(remaining);
            replaceSessions(remaining);
            return false;
        } catch (IOException e) {
            // The already durable tombstone remains in sessions and will be reconciled later.
            event("notice", obj("message", t("Codex 대화 삭제는 완료됐지만 목록 정리를 나중에 다시 시도합니다.")));
            return true;
        }
    }
    private JSONObject session(String id) {
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject session = sessions.optJSONObject(i);
            if (session != null && session.optString("id").equals(id)) return session;
        }
        return null;
    }
    /** A staged JSON copy invalidates JSONObject references, including an unrelated active conversation. */
    private void replaceSessions(JSONArray replacement) {
        sessions = replacement;
        if (active != null) {
            JSONObject restored = session(threadId);
            if (restored == null) clearActive();
            else active = restored;
        }
    }
    private JSONArray withoutPendingSession(String id) {
        JSONArray remaining = new JSONArray();
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject session = sessions.optJSONObject(i);
            if (session != null && session.optBoolean("deletionPending") && session.optString("id").equals(id)) continue;
            remaining.put(sessions.opt(i));
        }
        return remaining;
    }
    private boolean deleteRemote(String id, boolean retry) {
        try {
            call("thread/delete", obj("threadId", id));
            return true;
        } catch (Exception e) {
            // app-server v0.155.1 reports a missing root thread as "thread not found: <id>".
            // For a durable deletion tombstone that is already the requested end state.
            String message = unwrap(e).getMessage();
            if (retry && ("thread not found: " + id).equals(message)) return true;
            if (retry) event("notice", obj("message", t("삭제 대기 중인 Codex 대화를 아직 지우지 못했습니다.")));
            else event("notice", obj("message", t("Codex 대화 삭제를 나중에 다시 시도합니다.")));
            return false;
        }
    }
    private void retryPendingDeletions() {
        if (!ready) return;
        ArrayList<String> completed = new ArrayList<>();
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject session = sessions.optJSONObject(i);
            if (session != null && session.optBoolean("deletionPending")) {
                String remoteId = codexThreadId(session);
                if (remoteId.isBlank() || (sessionProviderMatches(session) && deleteRemote(remoteId, true))) completed.add(session.optString("id"));
            }
        }
        for (String id : completed) {
            JSONArray remaining = withoutPendingSession(id);
            try {
                persistSessions(remaining);
                replaceSessions(remaining);
            } catch (IOException e) {
                error("sessions.save", obj("message", t("대화 기록을 저장하지 못했습니다.")));
                return;
            }
        }
    }
    private void observeAgent(String method, JSONObject params) throws Exception {
        if (turnAgents.isEmpty()) return;
        String sender = params.optString("threadId");
        JSONObject spawned = method.equals("thread/started") ? params.optJSONObject("thread") : null;
        if (spawned != null) sender = spawned.optString("parentThreadId", "");
        if (sender.isBlank()) return;
        for (var entry : turnAgents.entrySet()) {
            TurnAgents agents = entry.getValue();
            JSONObject parent = session(entry.getKey());
            if (!inProviderScope(parent, eventScope.isBlank() ? providerScope() : eventScope)) continue;
            String root = codexThreadId(parent);
            boolean child = agents.contains(sender);
            if (!sender.equals(root) && !child) continue;
            boolean changed = false;
            if (spawned != null) {
                String id = spawned.optString("id", "");
                if (!id.equals(root) && !id.equals(sender)) changed = agents.spawned(id);
            } else if (method.equals("item/completed") && (child || agents.turn.equals(params.optString("turnId")))) {
                changed = agents.item(params.optJSONObject("item"), root, sender);
            } else if (child && (method.equals("turn/started") || method.equals("turn/completed"))) {
                changed = agents.setActive(sender, method.equals("turn/started"));
            } else if (child && method.equals("thread/status/changed")) {
                JSONObject status = params.optJSONObject("status");
                if (status != null) switch (status.optString("type")) {
                    case "active" -> changed = agents.setActive(sender, true);
                    case "idle", "systemError", "notLoaded" -> changed = agents.setActive(sender, false);
                }
            }
            if (changed) {
                saveAgentTotal(parent, agents);
                if (entry.getKey().equals(threadId)) publish();
            }
            return;
        }
    }
    private void saveAgentTotal(JSONObject parent, TurnAgents agents) throws Exception {
        JSONObject old = parent.optJSONObject("subagentUsage");
        if (old != null && old.optInt("total") == agents.total() && agents.turn.equals(old.optString("turnId"))) return;
        parent.put("subagentUsage", obj("turnId", agents.turn, "total", agents.total()));
        persist();
    }
    private void onNotification(String method, JSONObject p) {
        Object previousOperation = diagnosticOperation;
        diagnosticOperation = new Object();
        boolean refreshProgress = false;
        try {
            if (method.startsWith("thread/realtime/") || method.startsWith("account/")) return;
            if (method.equals("thread/started") || method.equals("thread/status/changed") || method.equals("item/completed")
                    || method.equals("turn/started") || method.equals("turn/completed")) {
                observeAgent(method, p);
                if (!taskLeaseActive && !runningTurns.isEmpty()) syncTaskCpu();
            }
            if (method.equals("serverRequest/resolved")) {
                Object id = p.opt("requestId");
                requests.entrySet().removeIf(entry -> {
                    if ((eventScope.isBlank() || eventScope.equals(entry.getValue().scope)) && String.valueOf(entry.getValue().id).equals(String.valueOf(id))) {
                        PendingRequest request = entry.getValue();
                        if (request.method.contains("requestApproval")) {
                            try { JSONObject approvalSession = sessionByCodexThreadId(request.params.optString("threadId")); if (approvalSession != null) { approvalSession.put("approvalPending", false); persist(); } } catch (Exception ignored) {}
                        }
                        event("server.resolved", obj("key", entry.getKey())); return true;
                    }
                    return false;
                });
                syncTaskCpu();
                return;
            }
            String remoteEventThreadId = p.optString("threadId");
            boolean implicitCurrentThread = remoteEventThreadId.isBlank();
            String eventThreadId = implicitCurrentThread && (eventScope.isBlank() || eventScope.equals(runtimeScope))
                ? threadId : localIdForCodexThread(remoteEventThreadId);
            boolean fromVisibleProvider = eventScope.isBlank() || eventScope.equals(runtimeScope);
            JSONObject target = implicitCurrentThread && fromVisibleProvider ? active : (eventThreadId.isBlank() ? null : session(eventThreadId));
            boolean currentThread = fromVisibleProvider && (implicitCurrentThread || eventThreadId.equals(threadId));
            TurnProgress progress = implicitCurrentThread ? null : turnProgress.get(eventThreadId);
            long now = System.currentTimeMillis();
            boolean advanced = progress != null && progress.observe(method, p, now);
            refreshProgress = advanced && currentThread;
            if (advanced && !implicitCurrentThread && retryingStreams.remove(eventThreadId) && currentThread) publish();
            // Raw reasoning, encrypted content and unscoped deltas never cross the WebView bridge.
            if (method.startsWith("item/reasoning/") || (p.optJSONObject("item") != null
                    && "reasoning".equals(p.optJSONObject("item").optString("type")))) return;
            if ((method.equals("item/agentMessage/delta") || method.equals("item/started") || method.equals("item/completed"))
                    && p.optString("turnId").equals(runningTurns.get(eventThreadId)) && retryingStreams.remove(eventThreadId) && currentThread) publish();
            String activityTurn = p.optString("turnId");
            boolean trackedWork = target != null && !activityTurn.isBlank() && activityTurn.equals(runningTurns.get(eventThreadId));
            boolean matchingProgress = progress != null && progress.turn.equals(activityTurn);
            boolean itemEvent = method.equals("item/started") || method.equals("item/completed");
            boolean commandOutput = method.equals("item/commandExecution/outputDelta");
            JSONObject activityItem = p.optJSONObject("item");
            boolean newCommand = trackedWork && activityItem != null && "commandExecution".equals(activityItem.optString("type"))
                && !"declined".equals(activityItem.optString("status"))
                && !WorkHistory.contains(target.optJSONArray("messages"), activityTurn, activityItem.optString("id"));
            if (trackedWork && (commandOutput || method.equals("item/fileChange/outputDelta"))) {
                JSONArray messages = target.optJSONArray("messages");
                String itemId = p.optString("itemId"), delta = p.optString("delta");
                if (WorkHistory.append(messages, activityTurn, itemId, delta)) {
                    persistSoon();
                    if (currentThread) event("agent.event", obj("threadId", eventThreadId, "method", method, "params", p));
                } else if (WorkHistory.record(messages, obj("id", itemId, "type", commandOutput ? "commandExecution" : "fileChange"), activityTurn, false, Integer.MAX_VALUE)) {
                    WorkHistory.append(messages, activityTurn, itemId, delta);
                    if (matchingProgress && commandOutput) progress.visibleActivity(now);
                    persistSoon(); if (currentThread) publish();
                }
            } else if (method.equals("item/agentMessage/delta") && target != null) {
                String id = p.optString("itemId"), delta = p.optString("delta");
                JSONObject previous = active;
                try { active = target; JSONObject message = message(id); message.put("text", message.optString("text") + delta); }
                finally { active = previous; }
                if (matchingProgress && !delta.isBlank()) progress.visibleActivity(now);
                if (currentThread) event("message.delta", obj("threadId", eventThreadId, "id", id, "delta", delta));
                else publish();
            } else if (itemEvent && target != null) {
                JSONObject item = activityItem;
                boolean completed = method.equals("item/completed");
                JSONArray messages = target.optJSONArray("messages");
                boolean workHandled = trackedWork && WorkHistory.record(messages, item, activityTurn, completed, Integer.MAX_VALUE);
                if (matchingProgress && workHandled && newCommand) progress.visibleActivity(now);
                boolean imageHandled = false, messageHandled = false;
                JSONObject previous = active;
                try {
                    active = target;
                    if (item != null && (!workHandled || item.has("result") || item.has("contentItems")))
                        imageHandled = withWorkspace(target.optString("workspaceKey"),
                        () -> recordImages(item, completed, p.optString("turnId", turnId)));
                    if (!imageHandled && completed && item != null && "agentMessage".equals(item.optString("type"))) {
                        boolean newText = recordAgentMessage(item, p.optString("turnId", runningTurns.getOrDefault(eventThreadId, "")));
                        if (matchingProgress && newText) progress.visibleActivity(now);
                        messageHandled = true;
                    }
                } finally { active = previous; }
                if (imageHandled || messageHandled) { persist(); publish(); }
                else if (workHandled) { persistSoon(); if (currentThread) publish(); }
                else if (currentThread && (item == null || !trackedWork || !WorkHistory.contains(messages, activityTurn, item.optString("id"))))
                    event("agent.event", obj("threadId", eventThreadId, "method", method, "params", p));
            } else if (method.equals("turn/diff/updated") && target != null) {
                target.put("turnDiff", p.optString("diff")); persistSoon(); publish();
            } else if (method.equals("turn/started")) {
                JSONObject turn = p.optJSONObject("turn"); String started = turn == null ? "" : turn.optString("id");
                if (!eventThreadId.isBlank() && !started.isBlank()) {
                    trackTurn(eventThreadId, started, System.currentTimeMillis());
                    if (target != null) target.remove("conversationFailure");
                }
                syncCurrentTurn(); publish();
            } else if (method.equals("turn/completed")) {
                JSONObject completedTurn = p.optJSONObject("turn");
                String completedId = completedTurn == null ? "" : completedTurn.optString("id");
                String runningId = runningTurns.get(eventThreadId);
                // Only the tracked top-level turn can finish a user task. Replayed,
                // child-thread and stray item completions must never notify again.
                if (target == null || eventThreadId.isBlank() || runningId == null
                        || completedId.isBlank() || !completedId.equals(runningId)
                        || "inProgress".equals(completedTurn.optString("status"))) return;
                runningTurns.remove(eventThreadId);
                turnProgress.remove(eventThreadId);
                if (runningTurns.isEmpty()) runtimeRecovery.edit().remove("backgroundScope").apply();
                target.remove("inFlightTurn"); retryingStreams.remove(eventThreadId);
                syncTaskCpu();
                TurnAgents finishedAgents = turnAgents.remove(eventThreadId);
                if (finishedAgents != null) {
                    JSONArray finalItems = completedTurn.optJSONArray("items");
                    String root = codexThreadId(target);
                    for (int index = 0; finalItems != null && index < finalItems.length(); index++)
                        finishedAgents.item(finalItems.optJSONObject(index), root, root);
                    if (finishedAgents.total() > 0) saveAgentTotal(target, finishedAgents);
                }
                if (target != null) target.put("approvalPending", false);
                syncCurrentTurn();
                JSONObject turn = p.optJSONObject("turn");
                String completionStatus = turn == null ? "" : turn.optString("status");
                boolean interrupted = "interrupted".equals(completionStatus);
                JSONObject error = turn == null ? null : turn.optJSONObject("error");
                boolean failed = !interrupted && ("failed".equals(completionStatus) || error != null);
                boolean successful = "completed".equals(completionStatus) && !failed;
                boolean missingReply = successful && !finishReply(target, turn);
                WorkHistory.finish(target.optJSONArray("messages"), completedId);
                if (failed) {
                    String failureCode = ConversationFailure.code(error);
                    target.put("conversationFailure", obj("code", failureCode, "turnId", completedId));
                } else if (!interrupted) target.remove("conversationFailure");
                if (currentThread && (interrupted || failed)) status = interrupted ? t("작업 중지됨") : t("작업 실패");
                if (target != null && !eventThreadId.isBlank() && !completedId.isBlank() && completedId.equals(runningId)
                        && "completed".equals(completionStatus) && error == null)
                    event("diagnostics.cleared", obj("operation", "chat", "_scope", eventThreadId));
                if (failed) error("chat.send", obj("threadId", eventThreadId, "message", ConversationFailure.message(ConversationFailure.code(error))), new DiagnosticFailure.RpcFailure("", error));
                if (currentThread && pendingApproval != null) pendingApproval.decision.complete(false);
                if (target != null) {
                    JSONObject previous = active;
                    try {
                        active = target;
                        JSONArray messages = active.getJSONArray("messages");
                        for (int i = 0; i < messages.length(); i++) {
                            JSONObject message = messages.getJSONObject(i);
                            if (message.optString("imageStatus").equals("generating")) message.put("imageStatus", "failed")
                                .put("imageError", interrupted ? t("작업이 중지되어 이미지 생성이 완료되지 않았습니다.") : t("이미지 생성이 완료되지 않았습니다. 다시 시도해 주세요."));
                        }
                    } finally { active = previous; }
                }
                persist(); publish();
                if (!fromVisibleProvider && runningTurns.keySet().stream().noneMatch(id -> inProviderScope(session(id), eventScope)))
                    retireProviderRuntime(eventScope);
                taskNotification(interrupted ? "interrupted" : failed ? "failed" : "completed",
                    interrupted ? t("작업 중지됨") : failed ? t("작업 실패") : missingReply ? t("작업 종료") : t("답변 완료"),
                    interrupted ? t("Codex 작업이 중지되었습니다.") : failed ? t("Codex 작업이 실패했습니다.")
                        : missingReply ? t("작업이 끝났지만 최종 답변을 받지 못했습니다.") : t("Codex가 작업을 마쳤습니다."), eventThreadId, "");
            } else if (method.equals("error")) {
                JSONObject error = p.optJSONObject("error");
                // Retried stream failures are progress, not a completed failed task.
                // Never forward arbitrary HTTP bodies (which can contain credentials).
                if (p.optBoolean("willRetry")) {
                    if (p.optString("turnId").equals(runningTurns.get(eventThreadId)) && retryingStreams.add(eventThreadId) && currentThread) publish();
                    return;
                }
                error("chat.send", obj("threadId", eventThreadId, "message", ConversationFailure.message(ConversationFailure.code(error))), new DiagnosticFailure.RpcFailure("", error));
            } else if (target != null && currentThread && (method.equals("item/commandExecution/outputDelta")
                    || method.equals("item/fileChange/outputDelta"))) {
                event("agent.event", obj("threadId", eventThreadId, "method", method, "params", p));
            }
        } catch (Exception e) {
            String remoteFailedThread = p.optString("threadId");
            String failedThread = remoteFailedThread.isBlank() ? threadId : localIdForCodexThread(remoteFailedThread);
            error(method.startsWith("account/") ? "auth.refresh" : method.startsWith("thread/") || method.startsWith("turn/") || method.startsWith("item/") || method.equals("error") ? "chat.send" : "other",
                obj("threadId", failedThread, "message", unwrap(e).getMessage()), e);
        } finally {
            diagnosticOperation = previousOperation;
            if (refreshProgress) queueProgress();
        }
    }
    private JSONObject readImage(String path) throws Exception {
        if (path.startsWith("sandbox:")) path = path.substring("sandbox:".length());
        if (path.startsWith("file://")) path = android.net.Uri.parse(path).getPath();
        if (path == null || path.isBlank()) throw new IOException(t("이미지 경로가 없습니다."));
        File file = new File(path);
        if (file.isAbsolute()) return images.importFile(file);
        if (documents.workspace().optBoolean("selected")) return documents.image(path, images);
        return images.importFile(new File(projectDirectory(), path));
    }
    private boolean recordImages(JSONObject item, boolean completed, String group) throws Exception {
        String type = item.optString("type");
        // Observation screenshots are tool context, not generated artwork for the persistent gallery.
        if (type.equals("dynamicToolCall") && (item.optString("tool").startsWith("mobile_phone_") || item.optString("name").startsWith("mobile_phone_"))) return false;
        boolean generation = type.equals("imageGeneration"), view = type.equals("imageView");
        JSONArray outputs = null;
        if (type.equals("mcpToolCall") && item.optJSONObject("result") != null) outputs = item.getJSONObject("result").optJSONArray("content");
        if (type.equals("dynamicToolCall")) outputs = item.optJSONArray("contentItems");
        JSONArray encoded = new JSONArray();
        if (outputs != null) for (int i = 0; i < outputs.length(); i++) {
            JSONObject part = outputs.optJSONObject(i); if (part == null) continue;
            if (part.optString("type").equals("image")) encoded.put(part.optString("data"));
            else if (part.optString("type").equals("inputImage") && part.optString("imageUrl").startsWith("data:image/")) encoded.put(part.getString("imageUrl"));
        }
        if (!generation && !view && encoded.length() == 0) return false;
        JSONObject message = message(item.getString("id"));
        if (!group.isEmpty()) message.put("imageGroup", group);
        if (completed && message.optJSONArray("images") != null && message.getJSONArray("images").length() > 0) return true;
        message.put("kind", "image").put("imageStatus", completed ? "completed" : "generating");
        if (!completed) return true;
        JSONArray attachments = new JSONArray();
        List<String> errors = new ArrayList<>();
        try {
            if (generation) {
                if (!item.isNull("failure") || item.optString("status").equals("failed"))
                    throw new IOException(t("이미지 생성에 실패했습니다. ") + (item.optJSONObject("failure") != null && "usageLimitExceeded".equals(item.getJSONObject("failure").optString("type")) ? t("이미지 사용 한도를 확인해 주세요.") : t("다시 시도해 주세요.")));
                String path = item.optString("savedPath", ""), result = item.optString("result", "");
                if (!path.isEmpty()) {
                    try { attachments.put(images.importFile(new File(path))); }
                    catch (Exception e) { if (result.isEmpty()) throw e; attachments.put(images.importBase64(result, "")); }
                } else if (!result.isEmpty()) attachments.put(images.importBase64(result, ""));
                else throw new IOException(t("생성 결과에 이미지 파일이 없습니다. 다시 생성해 주세요."));
            } else if (view) attachments.put(readImage(item.getString("path")));
        } catch (Exception e) { errors.add(unwrap(e).getMessage()); }
        for (int i = 0; i < encoded.length(); i++) {
            try { attachments.put(images.importBase64(encoded.getString(i), "")); }
            catch (Exception e) { errors.add((i + 1) + t("번째 이미지: ") + unwrap(e).getMessage()); }
        }
        if (errors.isEmpty()) message.remove("imageError");
        else message.put("imageStatus", "failed").put("imageError", String.join("\n", errors));
        message.put("images", attachments);
        return true;
    }
    private JSONObject message(String id) throws Exception {
        JSONArray messages = active.getJSONArray("messages");
        for (int i = messages.length() - 1; i >= 0; i--) {
            JSONObject m = messages.getJSONObject(i); if (m.optString("id").equals(id)) return m;
        }
        JSONObject m = obj("id", id, "role", "assistant", "text", "", "createdAt", System.currentTimeMillis()); messages.put(m); return m;
    }
    private void installUltraCatalog(File config, JSONObject profile) throws IOException {
        JSONArray models = profile.optJSONArray("models");
        for (int i = 0; models != null && i < models.length(); i++) {
            if (!Set.of("gpt-6.2-sol", "gpt-6.2-astra").contains(models.optString(i))) continue;
            String original = Utf8Files.read(config.toPath());
            // Custom catalogs (including profile-specific ones) remain authoritative.
            if (original.contains("model_catalog_json")) return;
            File catalog = new File(config.getParentFile(), "bundled-mobile-models.json");
            try (InputStream asset = context.getAssets().open("runtime/mobile-models.json")) {
                Files.copy(asset, catalog.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
            Utf8Files.write(config.toPath(), "model_catalog_json = " + ApiProviderPolicy.quote(catalog.getAbsolutePath()) + "\n" + original);
            return;
        }
    }
    private boolean recordAgentMessage(JSONObject item, String completedTurnId) throws Exception {
        JSONObject row = message(item.getString("id"));
        String text = item.optString("text");
        boolean newText = !text.isBlank() && !text.equals(row.optString("text"));
        row.put("text", text)
            .put("completedTurnId", completedTurnId).put("phase", item.optString("phase", ""));
        return newText;
    }
    private void trackTurn(String localThread, String id, long startedAt) throws org.json.JSONException {
        if (runningTurns.isEmpty()) runtimeRecovery.edit().putString("backgroundScope", providerScope()).apply();
        String previous = runningTurns.put(localThread, id);
        if (!id.equals(previous)) turnProgress.put(localThread, new TurnProgress(id, startedAt));
        syncTaskCpu();
        if (!id.equals(previous) || !turnAgents.containsKey(localThread)) {
            turnAgents.put(localThread, new TurnAgents(id));
            JSONObject target = session(localThread);
            retryingStreams.remove(localThread);
            if (target != null) { target.remove("subagentUsage"); target.put("inFlightTurn", id); }
        }
    }
    private boolean finishReply(JSONObject target, JSONObject turn) throws Exception {
        String completedTurnId = turn.getString("id");
        JSONObject previous = active;
        try {
            active = target;
            JSONArray items = turn.optJSONArray("items");
            for (int index = 0; items != null && index < items.length(); index++) {
                JSONObject item = items.optJSONObject(index);
                if (item != null && "agentMessage".equals(item.optString("type"))
                        && !item.optString("id").isBlank() && !item.optString("text").isBlank()
                        && !"commentary".equals(item.optString("phase"))) recordAgentMessage(item, completedTurnId);
            }
            JSONArray messages = target.getJSONArray("messages");
            for (int index = messages.length() - 1; index >= 0; index--) {
                JSONObject message = messages.optJSONObject(index);
                if (message != null && completedTurnId.equals(message.optString("completedTurnId"))
                        && !"commentary".equals(message.optString("phase")) && !message.optString("text").isBlank()) {
                    message.put("finalForTurn", true);
                    return true;
                }
            }
            messages.put(obj("id", "completion-" + completedTurnId, "role", "assistant", "kind", "completionNotice",
                "text", t("앱 알림: 작업이 끝났지만 최종 답변을 받지 못했습니다.")));
            return false;
        } finally { active = previous; }
    }
    private void onRequest(Object id, String method, JSONObject p) { onRequest(rpc, id, method, p); }
    private void onRequest(RpcClient connection, Object id, String method, JSONObject p) {
        try {
            if (!method.equals("item/tool/call")) {
                String key = UUID.randomUUID().toString();
                requests.put(key, new PendingRequest(connection, id, method, p, eventScope.isBlank() ? runtimeScope : eventScope));
                String remoteThread = p.optString("threadId");
                String localThread = remoteThread.isBlank() && (eventScope.isBlank() || eventScope.equals(runtimeScope))
                    ? threadId : localIdForCodexThread(remoteThread);
                if (method.contains("requestApproval")) {
                    String approvalThread = localThread;
                    JSONObject approvalSession = session(approvalThread);
                    if (approvalSession != null) { approvalSession.put("approvalPending", true); persist(); publish(); }
                    taskNotification("approval", t("승인 필요"), p.optString("reason", t("Codex 작업의 승인이 필요합니다.")), approvalThread, key);
                }
                JSONObject uiParams = new JSONObject(p.toString());
                if (!localThread.isBlank()) uiParams.put("threadId", localThread);
                event("server.request", obj("key", key, "method", method, "params", uiParams));
                syncTaskCpu();
                return;
            }
            String requestThreadId = localIdForCodexThread(p.optString("threadId"));
            JSONObject requestSession = session(requestThreadId);
            if (requestSession == null) throw new IOException(t("대화 작업을 찾을 수 없습니다."));
            String requestWorkspaceKey = requestSession.optString("workspaceKey");
            String tool = p.getString("tool"); JSONObject args = p.getJSONObject("arguments");
            String requestTurn = p.optString("turnId"), callId = p.optString("callId");
            if (!PhoneToolCatalog.NAMES.contains(tool) && !requestTurn.isBlank() && requestTurn.equals(runningTurns.get(requestThreadId)) && !callId.isBlank()) {
                JSONObject item = obj("id", callId, "type", "dynamicToolCall", "tool", tool, "arguments", args);
                if (WorkHistory.record(requestSession.optJSONArray("messages"), item, requestTurn, false, Integer.MAX_VALUE)) {
                    persistSoon(); if (requestThreadId.equals(threadId)) publish();
                }
            } else {
                event("tool", obj("threadId", requestThreadId, "turnId", requestTurn, "itemId", callId,
                    "name", tool, "path", args.optString("path", args.optString("query", ""))));
            }
            String previousToolThread = toolRequestThread;
            toolRequestThread = requestThreadId;
            try { withWorkspace(requestWorkspaceKey, () -> {
                if (PhoneToolCatalog.NAMES.contains(tool)) {
                    if (tool.equals("mobile_phone_action") && permissionMode.equals("read-only"))
                        throw new IOException(t("읽기 전용 모드에서는 화면 조회만 가능합니다. 조작하려면 작업 권한을 변경해 주세요."));
                    connection.respond(id, PhoneUseService.execute(context, tool, args));
                } else if (ToolCatalog.WRITE.contains(tool)) {
                    mutate(tool, args, false, (result, error) -> {
                        try { connection.respond(id, ToolCatalog.result(error == null, error == null ? result.toString() : error.getMessage())); }
                        catch (IOException ignored) {}
                    });
                } else {
                    JSONObject result = switch (tool) {
                        case "mobile_list" -> documents.list(args.optString("path", ""));
                        case "mobile_search" -> documents.search(args.getString("query"));
                        case "mobile_read" -> documents.read(args.getString("path"));
                        default -> throw new IOException(t("알 수 없는 파일 도구입니다."));
                    };
                    connection.respond(id, ToolCatalog.result(true, result.toString()));
                }
                return null;
            }); } finally { toolRequestThread = previousToolThread; }
        } catch (Exception e) {
            if (connection != null) try { connection.respond(id, ToolCatalog.result(false, unwrap(e).getMessage())); } catch (IOException ignored) {}
        }
    }
    private void mutate(String operation, JSONObject args, boolean interactive, Reply reply) throws Exception {
        if (!ToolCatalog.WRITE.contains(operation)) throw new IOException(t("지원하지 않는 파일 작업입니다."));
        if (permissionMode.equals("read-only")) throw new IOException(t("현재 읽기 전용 모드입니다. 권한 설정을 변경해 주세요."));
        if (pendingApproval != null && !pendingApproval.decision.isDone()) throw new IOException(t("다른 변경 사항을 확인 중입니다. 한 번에 하나씩 요청해 주세요."));
        DocumentStore.Mutation mutation = documents.prepare(operation, args);
        if (!interactive) {
            JSONObject result = documents.commit(mutation); filesChanged(result); reply.complete(result, null); return;
        }
        Approval approval = new Approval(mutation.title, mutation.preview);
        String approvalWorkspaceKey = documents.key();
        pendingApproval = approval;
        String approvalThread = threadId;
        JSONObject approvalSession = session(approvalThread);
        if (approvalSession != null) { approvalSession.put("approvalPending", true); persist(); publish(); }
        ScheduledFuture<?> timeout = approvalTimer.schedule(() -> approval.decision.complete(false), 10, TimeUnit.MINUTES);
        approval.decision.whenCompleteAsync((approved, error) -> {
            timeout.cancel(false);
            if (pendingApproval == approval) pendingApproval = null;
            try {
                JSONObject finishedApprovalSession = session(approvalThread);
                if (finishedApprovalSession != null) { finishedApprovalSession.put("approvalPending", false); persist(); publish(); }
                if (error != null || !Boolean.TRUE.equals(approved)) throw new IOException(t("사용자가 변경을 취소했습니다."));
                if (!approvalWorkspaceKey.equals(documents.key())) throw new IOException(t("프로젝트가 바뀌었습니다. 다시 열어 주세요."));
                JSONObject result = documents.commit(mutation);
                filesChanged(result); reply.complete(result, null);
            } catch (Throwable e) { reply.complete(null, unwrap(e)); }
        }, io);
        Ui current = ui;
        taskNotification("approval", t("승인 필요"), approval.title, threadId, approval.id);
        if (current != null) current.approval(approval);
        for (Ui observer : observers) if (observer != current) observer.approval(approval);
        if (current == null && observers.isEmpty()) approval.decision.complete(false);
    }
    public void stop() {
        stopTerminalProcess();
        PhoneUseService.stopControl();
        linux.cancel();
        // Closing approval first allows a pending action to resolve without changes.
        Approval approval = pendingApproval; if (approval != null) approval.decision.complete(false);
        io.execute(this::stopNow);
    }
    private void stopNow() { stopTerminalProcess(); stopCodex(); }
    private void stopCodex() {
        runtimeRecovery.edit().remove("scope").remove("backgroundScope").apply();
        PhoneUseService.stopControl();
        if (pendingApproval != null) pendingApproval.decision.complete(false);
        for (String scope : new ArrayList<>(parkedRuntimes.keySet())) retireProviderRuntime(scope);
        retireProviderRuntime(runtimeScope);
        status = t("연결 종료");
        persist(); publish();
        stopServiceIfIdle();
    }
    private void retireProviderRuntime(String scope) {
        if (scope.isBlank() && !runtimeScope.isBlank()) return;
        ParkedRuntime runtime;
        if (scope.equals(runtimeScope)) {
            runtime = new ParkedRuntime(process, rpc, processHome);
            process = null; rpc = null; ready = false; serverThreadId = "";
        } else {
            runtime = parkedRuntimes.remove(scope);
            if (runtime == null) return;
        }
        Process old = runtime.process;
        if (old != null) {
            old.destroyForcibly();
            // Finish the old process before a provider or credential revision can be activated.
            try { if (!old.waitFor(2, TimeUnit.SECONDS) && old.isAlive()) old.destroyForcibly(); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        }
        if (runtime.connection != null) runtime.connection.close();
        clearRequests(runtime.connection);
        clearRunningState(scope);
    }
    private void clearRequests(RpcClient connection) {
        requests.entrySet().removeIf(entry -> {
            if (entry.getValue().connection != connection) return false;
            event("server.resolved", obj("key", entry.getKey()));
            return true;
        });
    }
    /** Whether a config still declares the retired Pro MCP server (table or dotted keys). */
    static boolean retiredProBridgeConfigured(File config) {
        try { return config.isFile() && java.util.regex.Pattern.compile("(?m)^\\s*\\[?\\s*mcp_servers\\.\"?mobile_codex_pro\\b").matcher(dev.mobilecodex.app.core.Utf8Files.read(config.toPath())).find(); }
        catch (Exception e) { return false; }
    }
    private File projectDirectory() { File dir = documents.directDirectory(); return dir == null ? workDir : dir; }
    /**
     * DocumentStore intentionally has one selected tree. Background turns must
     * nevertheless use their own project without changing the visible project.
     * Engine work is serialized on io, so a scoped switch is safe as long as it
     * is restored in finally before any state is published.
     */
    private <T> T withWorkspace(String workspaceKey, Callable<T> work) throws Exception {
        String previous = documents.key();
        boolean switched = !Objects.equals(previous, workspaceKey);
        if (switched) documents.selectProject(workspaceKey == null ? "" : workspaceKey);
        try { return work.call(); }
        finally { if (switched) documents.selectProject(previous); }
    }
    private void filesChanged(JSONObject result) {
        try {
            JSONObject payload = new JSONObject(result.toString());
            payload.put("threadId", toolRequestThread.isBlank() ? threadId : toolRequestThread);
            event("files.changed", payload);
        } catch (Exception ignored) { event("files.changed", result); }
    }
    /** Every room tool is authorized again here, below the CLI/MCP boundary. */
    private File runtimeAliases() throws Exception {
        File bin = new File(context.getFilesDir(), "runtime-bin");
        if (!bin.isDirectory() && !bin.mkdirs()) throw new IOException(t("명령 경로를 만들 수 없습니다."));
        for (String[] pair : new String[][]{{"codex", "libcodex.so"}, {"codex-code-mode-host", "libcodexmodehostx.so"}}) {
            File alias = new File(bin, pair[0]);
            String target = new File(context.getApplicationInfo().nativeLibraryDir, pair[1]).getAbsolutePath();
            try { if (android.system.Os.readlink(alias.getAbsolutePath()).equals(target)) continue; } catch (android.system.ErrnoException ignored) {}
            Files.deleteIfExists(alias.toPath());
            android.system.Os.symlink(target, alias.getAbsolutePath());
        }
        return bin;
    }
    private JSONObject runTerminal(String command) throws Exception {
        if (terminal.busy()) throw new IOException(t("터미널 명령이 실행 중입니다."));
        if (command.isBlank()) throw new IOException(t("명령을 입력해 주세요."));
        documents.requireWorkspaceAvailable();
        if (documents.workspace().optBoolean("selected") && documents.directDirectory() == null)
            throw new IOException(t("이 문서 제공자 폴더에서는 셸을 실행할 수 없습니다. 기기 파일 접근 권한을 확인하거나 일반 대화의 앱 내부 작업 폴더를 사용해 주세요."));
        ProcessBuilder builder;
        boolean useLinux = linux.status().optBoolean("enabled");
        if (useLinux) builder = linux.command(command, projectDirectory(), codexHome.root(), runtimeAliases());
        else {
            builder = new ProcessBuilder("/system/bin/sh", "-c", command).directory(projectDirectory());
            devTools.configure(builder, codexHome.root(), runtimeAliases());
            linux.configureEnvironment(builder.environment());
        }
        builder.redirectErrorStream(true);
        File helper = new File(context.getFilesDir(), "terminal_io.py");
        try (InputStream in = context.getAssets().open("rooms/terminal_io.py")) {
            Files.copy(in, helper.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }
        List<String> argv = new ArrayList<>(List.of(builder.environment().get("MC_PYTHON"), helper.getAbsolutePath()));
        argv.addAll(builder.command()); builder.command(argv);
        context.startForegroundService(new Intent(context, EngineService.class));
        try { return terminal.start(builder); }
        catch (Exception error) { stopServiceIfIdle(); throw error; }
    }
    private void stopTerminalProcess() {
        try { terminal.stop(null); } catch (IOException ignored) {}
    }
}
