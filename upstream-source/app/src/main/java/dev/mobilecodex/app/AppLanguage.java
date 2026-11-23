package dev.mobilecodex.app;

import android.content.Context;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.*;
import dev.mobilecodex.app.core.Texts;
import static dev.mobilecodex.app.core.Json.*;

final class AppLanguage {
    private static Map<String, String> english = Map.of();
    private static Map<String, String> chinese = Map.of();
    static void initialize(Context context) {
        english = load(context, "translations-en.json");
        var translated = new HashMap<>(load(context, "translations-zh-CN.json"));
        // Persisted status messages may already use the English display string.
        english.forEach((source, value) -> {
            translated.putIfAbsent(value, translated.getOrDefault(source, source));
        });
        chinese = Map.copyOf(translated);
        configure(context);
    }
    private static Map<String, String> load(Context context, String asset) {
        try (var stream = context.getAssets().open(asset)) {
            var bytes = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192]; int count;
            while ((count = stream.read(buffer)) != -1) bytes.write(buffer, 0, count);
            JSONObject json = new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
            var values = new HashMap<String, String>();
            for (var keys = json.keys(); keys.hasNext();) { String key = keys.next(); values.put(key, json.getString(key)); }
            return Map.copyOf(values);
        } catch (Exception failure) { android.util.Log.e("AppLanguage", "Unable to load bundled translations", failure); }
        return Map.of();
    }
    static String choice(Context context) {
        String saved = context.getSharedPreferences("appearance", 0).getString("language", "zh-CN");
        return saved.equals("system") || saved.equals("en") ? saved : "zh-CN";
    }
    static Locale locale(Context context) {
        String choice = choice(context);
        if (!choice.equals("system")) return Locale.forLanguageTag(choice);
        Locale device = context.getResources().getConfiguration().getLocales().get(0);
        return "en".equals(device.getLanguage()) ? device : Locale.SIMPLIFIED_CHINESE;
    }
    static String brandName() { return "fresh".equals(BuildConfig.BUILD_TYPE) ? "大肥龙" : ""; }
    static void configure(Context context) {
        String language = locale(context).getLanguage();
        Texts.configure(language.equals("zh") ? chinese : english, brandName());
    }
    static JSONObject snapshot(Context context) { return obj("brandName", brandName(), "choice", choice(context), "systemLanguage", context.getResources().getConfiguration().getLocales().get(0).toLanguageTag()); }
    @android.annotation.SuppressLint("ApplySharedPref")
    static void set(Context context, String value) throws java.io.IOException {
        if (!Set.of("system", "zh-CN", "en").contains(value)) throw new IllegalArgumentException("Unsupported language");
        if (!context.getSharedPreferences("appearance", 0).edit().putString("language", value).commit()) throw new java.io.IOException("Unable to save language setting");
        configure(context);
    }
}
