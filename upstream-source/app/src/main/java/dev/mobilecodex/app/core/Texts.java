package dev.mobilecodex.app.core;

import java.util.Map;

/** Translation is explicit at UI/error construction sites; never applied to file or model content. */
public final class Texts {
    private record Catalog(boolean korean, Map<String, String> english, Map<String, String> source, String brandName) {}
    private static final java.util.regex.Pattern BEFORE_BRAND = java.util.regex.Pattern.compile("([\u3400-\u9fff]) (?=(?:Mobile )?Codex\\b)");
    private static final java.util.regex.Pattern AFTER_BRAND = java.util.regex.Pattern.compile("((?:Mobile )?Codex(?: CN)?) (?=[\u3400-\u9fff])");
    private static volatile Catalog catalog = new Catalog(true, Map.of(), Map.of(), "");
    private Texts() {}
    public static void configure(boolean korean, Map<String, String> english) {
        configure(korean, english, "");
    }
    public static void configure(boolean korean, Map<String, String> english, String brandName) {
        var reverse = new java.util.HashMap<String, String>();
        english.forEach((key, value) -> reverse.putIfAbsent(value, key));
        catalog = new Catalog(korean, Map.copyOf(english), Map.copyOf(reverse), brandName);
    }
    public static String t(String text) {
        if (text == null) return null;
        Catalog c = catalog;
        String key = c.source.getOrDefault(text, text);
        String value = c.korean ? key : c.english.getOrDefault(text, text);
        if (c.brandName.isEmpty() || !value.contains("Codex") || key.startsWith("Android용 Codex 포트")) return value;
        // Never rewrite arbitrary server messages, filenames or user-supplied text.
        if (!c.english.containsKey(text) && !c.source.containsKey(text)
                && !text.equals("Codex CN") && !text.equals("Mobile Codex") && !text.equals("Codex")) return value;
        value = AFTER_BRAND.matcher(BEFORE_BRAND.matcher(value).replaceAll("$1")).replaceAll("$1");
        return value.replace("Mobile Codex", c.brandName).replace("Codex CN", c.brandName).replace("Codex", c.brandName);
    }
}
