package dev.mobilecodex.app;

import android.content.*;
import android.os.*;
import android.speech.*;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.function.Consumer;
import static dev.mobilecodex.app.core.Json.*;
import static dev.mobilecodex.app.core.Texts.t;

/** Owns one microphone session. Results use the same durable, scoped receipts as floating chat. */
final class InlineDictation {
    private final Context context;
    private final Consumer<JSONObject> events;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private JSONObject request;
    private String phase = "idle", partial = "";
    private long started;
    private float level;
    private Runnable deadline;
    InlineDictation(Context context, Consumer<JSONObject> events) { this.context = context; this.events = events; }
    JSONObject prepare(JSONObject draft) throws Exception {
        request = VoiceInput.begin(context, "main", draft);
        partial = ""; level = 0; started = 0;
        phase = "permission"; emit();
        return obj("requestId", request.optString("receiptId"));
    }
    boolean waitingPermission() { return phase.equals("permission"); }
    JSONObject snapshot() { return obj("phase", phase, "partial", partial, "level", level, "elapsedMs", started == 0 ? 0 : SystemClock.elapsedRealtime() - started); }
    private void emit() { events.accept(snapshot()); }
    void start() {
        if (request == null || !waitingPermission()) return;
        if (!SpeechRecognizer.isRecognitionAvailable(context)) { finish("", t("设备的语音识别服务不可用，请在设备设置中启用。")); return; }
        final JSONObject session = request;
        try {
            phase = "starting"; emit();
            recognizer = SpeechRecognizer.createSpeechRecognizer(context);
            recognizer.setRecognitionListener(new RecognitionListener() {
                private boolean current() { return request == session; }
                public void onReadyForSpeech(Bundle params) { if (current() && phase.equals("starting")) { phase = "listening"; started = SystemClock.elapsedRealtime(); emit(); if (deadline != null) handler.removeCallbacks(deadline); } }
                public void onBeginningOfSpeech() { }
                public void onRmsChanged(float rms) { if (current() && phase.equals("listening")) { level = Math.max(0, Math.min(1, (rms + 2) / 12)); emit(); } }
                public void onBufferReceived(byte[] buffer) { }
                public void onEndOfSpeech() { if (current()) transcribing(); }
                public void onError(int error) { if (current()) finish("", errorMessage(error)); }
                public void onResults(Bundle results) {
                    if (!current()) return;
                    String text = resultText(results);
                    finish(text, text.isEmpty() ? t("未能识别语音，请重试。") : "");
                }
                public void onPartialResults(Bundle results) { if (current()) { partial = resultText(results); emit(); } }
                public void onEvent(int type, Bundle params) { }
            });
            Intent intent = VoiceInputActivity.recognitionIntent(AppLanguage.locale(context))
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            recognizer.startListening(intent);
            timeout(15000);
        } catch (RuntimeException error) { finish("", t("无法启动麦克风，请检查麦克风权限和语音识别设置。")); }
    }
    static String resultText(Bundle results) {
        ArrayList<String> values = results == null ? null : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (values != null) for (String value : values) if (value != null && !value.isBlank()) return value.trim();
        return "";
    }
    static String errorMessage(int code) {
        return switch (code) {
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> t("需要麦克风权限，请在应用权限中允许访问麦克风。");
            case SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> t("未能识别语音，请重试。");
            case SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> t("无法连接语音识别服务，请检查网络连接。");
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> t("其他应用正在使用语音识别，请稍后重试。");
            default -> t("语音识别已停止，请重试。");
        };
    }
    void denied() { if (waitingPermission()) finish("", errorMessage(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS)); }
    void stop() { if (recognizer != null && (phase.equals("listening") || phase.equals("starting"))) { transcribing(); try { recognizer.stopListening(); } catch (RuntimeException error) { finish("", errorMessage(SpeechRecognizer.ERROR_CLIENT)); } } }
    private void transcribing() { phase = "transcribing"; level = 0; emit(); timeout(15000); }
    private void timeout(long delay) {
        if (deadline != null) handler.removeCallbacks(deadline);
        JSONObject session = request;
        deadline = () -> { if (request == session && session != null) { if (phase.equals("listening")) stop(); else finish("", t("语音识别超时，请重试。")); } };
        handler.postDelayed(deadline, delay);
    }
    void cancel() { if (request != null) finish("", ""); }
    private void finish(String text, String error) {
        if (request == null) return;
        JSONObject completed = request;
        request = null; // Invalidate late callbacks before cancel/destroy.
        if (deadline != null) handler.removeCallbacks(deadline);
        if (recognizer != null) { SpeechRecognizer old = recognizer; recognizer = null; try { old.cancel(); } catch (RuntimeException ignored) {} old.destroy(); }
        phase = "idle"; partial = ""; level = 0; started = 0;
        try { VoiceInput.complete(context, completed, text, error); }
        catch (Exception failure) {
            // Do not discard a transcript when durable storage is full. Offer a selectable copy.
            VoiceInput.release(context, completed.optString("receiptId"));
            android.widget.TextView message = new android.widget.TextView(context); message.setPadding(32, 24, 32, 24); message.setTextIsSelectable(true);
            message.setText(text.isEmpty() ? t("无法保存语音输入结果。") : text);
            new android.app.AlertDialog.Builder(context).setTitle(t("无法保存语音识别结果"))
                .setView(message).setPositiveButton(t("复制并关闭"), (dialog, which) -> {
                    if (!text.isEmpty()) context.getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText(t("语音听写"), text));
                }).show();
        }
        emit();
    }
}
