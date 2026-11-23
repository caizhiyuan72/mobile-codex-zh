package dev.mobilecodex.app.core;

import java.util.Map;
import java.util.Set;

/** Translation is explicit at UI/error construction sites; never applied to file or model content. */
public final class Texts {
    private record Catalog(Map<String, String> labels, Set<String> knownLabels, String brandName) {}
    private static final java.util.regex.Pattern BEFORE_BRAND = java.util.regex.Pattern.compile("([\u3400-\u9fff]) (?=(?:Mobile )?Codex\\b)");
    private static final java.util.regex.Pattern AFTER_BRAND = java.util.regex.Pattern.compile("((?:Mobile )?Codex(?: CN)?) (?=[\u3400-\u9fff])");
    private static volatile Catalog catalog = new Catalog(Map.of(), Set.of(), "");
    private Texts() {}
    public static void configure(Map<String, String> labels) {
        configure(labels, "");
    }
    public static void configure(Map<String, String> labels, String brandName) {
        var knownLabels = new java.util.HashSet<>(labels.keySet());
        knownLabels.addAll(labels.values());
        catalog = new Catalog(Map.copyOf(labels), Set.copyOf(knownLabels), brandName);
    }
    public static String t(String text) {
        if (text == null) return null;
        Catalog c = catalog;
        String value = c.labels.getOrDefault(text, text);
        if (c.brandName.isEmpty() || !value.contains("Codex")
                || value.startsWith("Android Codex 移植版") || value.startsWith("Android Codex port")) return value;
        // Never rewrite arbitrary server messages, filenames or user-supplied text.
        if (!c.knownLabels.contains(text)
                && !text.equals("Codex CN") && !text.equals("Mobile Codex") && !text.equals("Codex")) return value;
        value = AFTER_BRAND.matcher(BEFORE_BRAND.matcher(value).replaceAll("$1")).replaceAll("$1");
        return value.replace("Mobile Codex", c.brandName).replace("Codex CN", c.brandName).replace("Codex", c.brandName);
    }
}
