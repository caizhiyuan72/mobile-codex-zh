package dev.mobilecodex.app.core;

import static dev.mobilecodex.app.core.Texts.t;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.List;

public final class WorkspacePath {
    private WorkspacePath() {}
    public static List<String> segments(String path) {
        if (path == null || path.isEmpty()) return List.of();
        if (path.startsWith("/") || path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0)
            throw new IllegalArgumentException(t("只允许所选文件夹内的相对路径。"));
        List<String> parts = Arrays.asList(path.split("/", -1));
        for (String part : parts) checkName(part);
        if (parts.size() > 64) throw new IllegalArgumentException(t("文件夹路径层级过深。"));
        return parts;
    }
    public static void checkName(String name) {
        if (name == null || name.isBlank() || name.equals(".") || name.equals("..") ||
            name.contains("/") || name.contains("\\") || name.chars().anyMatch(c -> c < 32))
            throw new IllegalArgumentException(t("请输入有效的文件或文件夹名称。"));
    }
    public static String parent(String path) {
        segments(path);
        int slash = path.lastIndexOf('/');
        return slash < 0 ? "" : path.substring(0, slash);
    }
    public static String name(String path) {
        segments(path);
        return path.substring(path.lastIndexOf('/') + 1);
    }
    public static String hash(byte[] data) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
            StringBuilder b = new StringBuilder();
            for (byte v : digest) b.append(String.format("%02x", v & 255));
            return b.toString();
        } catch (Exception e) { throw new IllegalStateException(e); }
    }
    public static String hash(String text) { return hash(text.getBytes(StandardCharsets.UTF_8)); }
    public static void requireVersion(String expected, byte[] current) {
        if (expected == null || !expected.equals(hash(current)))
            throw new IllegalStateException(t("文件已变化，请重新读取后再编辑。"));
    }
}
