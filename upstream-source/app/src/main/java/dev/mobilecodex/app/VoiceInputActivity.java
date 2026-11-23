package dev.mobilecodex.app;

import static dev.mobilecodex.app.core.Texts.t;
import android.app.*;
import android.content.*;
import android.os.Bundle;
import android.speech.RecognizerIntent;
import android.widget.*;
import org.json.JSONObject;
import java.util.*;
import static dev.mobilecodex.app.core.Json.*;

/** Private trampoline for the installed recognizer's visible microphone UI, also usable from the overlay. */
public final class VoiceInputActivity extends Activity {
    private static final int RECOGNIZE = 81;
    private static final int SPACE_8_DP = 8, SPACE_12_DP = 12;
    private JSONObject request;
    private boolean delivered;
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        request = parse(getIntent().getStringExtra("request"));
        if (request.optString("receiptId").isEmpty()) { finish(); return; }
        VoiceInput.activate(this, request.optString("receiptId"));
        LinearLayout panel = new LinearLayout(this); panel.setOrientation(LinearLayout.VERTICAL); panel.setPadding(dp(SPACE_12_DP), dp(SPACE_8_DP), dp(SPACE_12_DP), dp(SPACE_8_DP));
        TextView note = new TextView(this); note.setText(t("语音输入\n识别的文字将进入草稿，请检查后再发送。\n语音识别由设备配置的服务处理。")); note.setTextSize(16); panel.addView(note);
        Button cancel = new Button(this); cancel.setText(t("取消")); cancel.setOnClickListener(v -> deliver("", "")); panel.addView(cancel);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.addView(panel, new ScrollView.LayoutParams(-1, -2)); setContentView(scroll);
        if (android.os.Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, () -> deliver("", ""));
        if (saved == null) {
            try { startActivityForResult(recognitionIntent(Locale.getDefault()), RECOGNIZE); }
            catch (ActivityNotFoundException error) { deliver("", t("没有可用的语音识别应用。请安装或启用设备的语音输入服务。")); }
            catch (RuntimeException error) { deliver("", t("无法启动语音识别。请检查语音设置和麦克风权限。")); }
        }
    }
    static Intent recognitionIntent(Locale locale) {
        return new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale.toLanguageTag())
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            .putExtra(RecognizerIntent.EXTRA_PROMPT, t("请开始说话。发送前可以检查内容。"));
    }
    static String recognizedText(int result, Intent data) {
        if (result != RESULT_OK || data == null) return "";
        ArrayList<String> alternatives = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        if (alternatives != null) for (String text : alternatives) if (text != null && !text.isBlank()) return text.trim();
        return "";
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == RECOGNIZE) {
            String text = recognizedText(result, data);
            deliver(text, result == RESULT_OK && text.isEmpty() ? t("未能识别语音，请重试。") : "");
        }
    }
    private void deliver(String text, String error) {
        if (delivered) return;
        try { VoiceInput.complete(this, request, text, error); delivered = true; finish(); }
        catch (Exception failure) {
            new AlertDialog.Builder(this).setTitle(t("无法保存语音识别结果")).setMessage(text.isEmpty() ? failure.getMessage() : text)
                .setPositiveButton(t("复制并关闭"), (dialog, which) -> { if (!text.isEmpty()) getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText(t("语音听写"), text)); delivered = true; finish(); })
                .setNegativeButton(t("重试保存"), (dialog, which) -> deliver(text, error)).setCancelable(false).show();
        }
    }
    @Override public void onBackPressed() { deliver("", ""); }
    @Override protected void onDestroy() {
        if (isFinishing() && request != null) VoiceInput.release(this, request.optString("receiptId"));
        super.onDestroy();
    }
}
