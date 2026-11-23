package dev.mobilecodex.app.core;

import static dev.mobilecodex.app.core.Texts.t;
import org.json.*;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.nio.file.*;
import java.util.*;
import static dev.mobilecodex.app.core.Json.*;

/** Local file previews with compare-before-restore and durable recovery copies. Never changes Git's index. */
public final class ChangeReview {
    public interface Runner { byte[] run(File directory, List<String> args) throws Exception; }
    private static final int LIMIT = 8 * 1024 * 1024;
    private final File backups;
    private final Runner runner;
    private final LinkedHashMap<String, Preview> previews = new LinkedHashMap<>();
    private record Preview(File root, String path, byte[] expected, byte[] replacement, String head, String label, long time) {}
    public ChangeReview(File backups, Runner runner) { this.backups = backups; this.runner = runner; }
    private byte[] git(File root, String... args) throws Exception { return runner.run(root, Arrays.asList(args)); }
    private String head(File root) throws Exception {
        git(root, "rev-parse", "--is-inside-work-tree");
        try { return new String(git(root, "rev-parse", "--verify", "HEAD"), StandardCharsets.UTF_8).trim(); }
        catch (Exception unborn) { return ""; }
    }
    public JSONObject list(File root) throws Exception {
        String status = new String(git(root, "-c", "status.relativePaths=true", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", "."), StandardCharsets.UTF_8);
        JSONArray entries = new JSONArray();
        for (String item : status.split("\u0000")) {
            if (item.length() < 4) continue;
            String path = item.substring(3);
            entries.put(obj("path", path, "status", item.substring(0, 2)));
        }
        return obj("entries", entries, "note", t("比较 Git HEAD 与工作文件，包括你自己的更改。恢复只修改文件内容，不会改变暂存区。"));
    }
    public JSONObject preview(File root, String path) throws Exception {
        Path target = safe(root, path); byte[] current = read(target);
        String head = head(root); byte[] original = null;
        if (!head.isEmpty()) {
            String tree = new String(git(root, "ls-tree", "-z", head, "--", path), StandardCharsets.UTF_8);
            if (!tree.isEmpty()) {
                String[] fields = tree.substring(0, tree.indexOf('\t')).split(" ");
                if (!fields[0].equals("100644") && !fields[0].equals("100755")) throw new IOException(t("只能恢复普通文件。请在终端中检查链接和子模块。"));
                original = git(root, "cat-file", "blob", fields[2]);
            }
        }
        return remember(root, path, current, original, head, t("恢复到 HEAD 的内容"));
    }
    private JSONObject remember(File root, String path, byte[] current, byte[] replacement, String head, String label) throws Exception {
        if ((current != null && current.length > LIMIT) || (replacement != null && replacement.length > LIMIT)) throw new IOException(t("请在终端中检查超过 8 MiB 的文件。"));
        String token = UUID.randomUUID().toString();
        while (previews.size() >= 8) previews.remove(previews.keySet().iterator().next());
        previews.put(token, new Preview(root.getCanonicalFile(), path, current, replacement, head, label, System.currentTimeMillis()));
        String before = text(replacement), after = text(current);
        boolean limited = before.startsWith(t("[二进制文件")) || after.startsWith(t("[二进制文件")) || before.startsWith(t("[大文件")) || after.startsWith(t("[大文件"));
        return obj("token", token, "path", path, "before", before, "after", after, "beforeExists", replacement != null,
            "afterExists", current != null, "actionLabel", label, "canRestore", !Arrays.equals(current, replacement),
            "previewLimited", limited, "beforeSha256", hash(replacement), "afterSha256", hash(current),
            "note", t("恢复前将先备份当前文件。若文件在其他地方发生变化，将停止恢复。Git 暂存区不变。"));
    }
    public JSONObject restore(File root, String token) throws Exception {
        Preview p = previews.get(token);
        if (p == null || !p.root.equals(root.getCanonicalFile()) || System.currentTimeMillis() - p.time > 300000) throw new IOException(t("预览已过期或项目已变更，请重新打开。"));
        Path target = safe(root, p.path);
        if (p.head != null && !p.head.equals(head(root))) throw new IOException(t("Git HEAD 已更改，请重新审查更改。"));
        if (!Arrays.equals(read(target), p.expected)) throw new IOException(t("文件在预览后发生了变化，未被覆盖。"));
        if (Arrays.equals(p.expected, p.replacement)) throw new IOException(t("没有需要恢复的更改。"));
        Files.createDirectories(backups.toPath()); String id = UUID.randomUUID().toString();
        if (p.expected != null) Files.write(new File(backups, id + ".bin").toPath(), p.expected, StandardOpenOption.CREATE_NEW);
        JSONObject meta = obj("id", id, "root", p.root.getPath(), "path", p.path, "timestamp", System.currentTimeMillis(),
            "existed", p.expected != null, "sha256", hash(p.expected), "expectedAfter", hash(p.replacement), "completed", false);
        File metadata = new File(backups, id + ".json"); save(metadata, meta);
        // Recheck after backup I/O as another application can edit this file independently.
        if (!Arrays.equals(read(safe(root, p.path)), p.expected)) throw new IOException(t("文件在备份期间发生了变化，未被覆盖。"));
        if (p.replacement == null) Files.delete(target);
        else {
            if (!Files.isDirectory(target.getParent())) throw new IOException(t("上级文件夹不存在，请先恢复文件夹。"));
            Path stage = Files.createTempFile(target.getParent(), ".mobile-codex-restore-", ".tmp");
            try {
                Files.write(stage, p.replacement);
                if (Files.exists(target)) {
                    try { Files.setPosixFilePermissions(stage, Files.getPosixFilePermissions(target)); } catch (UnsupportedOperationException ignored) {}
                }
                if (!Arrays.equals(read(safe(root, p.path)), p.expected)) throw new IOException(t("文件已变化，请重新检查。"));
                Files.move(stage, target, StandardCopyOption.REPLACE_EXISTING);
            } finally { Files.deleteIfExists(stage); }
        }
        if (!Arrays.equals(read(target), p.replacement)) throw new IOException(t("无法验证恢复的内容，请检查恢复副本。"));
        meta.put("completed", true); save(metadata, meta); previews.remove(token);
        return obj("ok", true, "path", p.path, "backupId", id);
    }
    public JSONArray history(File root) throws Exception {
        JSONArray entries = new JSONArray(); File[] files = backups.listFiles((dir, name) -> name.endsWith(".json"));
        if (files == null) return entries;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified).reversed());
        for (File file : files) {
            JSONObject item = parse(Utf8Files.read(file.toPath()));
            if (root.getCanonicalPath().equals(item.optString("root"))) { item.remove("root"); entries.put(item); }
        }
        return entries;
    }
    public JSONObject previewBackup(File root, String id) throws Exception {
        if (!id.matches("[a-f0-9-]{36}")) throw new IOException(t("恢复记录无效。"));
        JSONObject item = parse(Utf8Files.read(new File(backups, id + ".json").toPath()));
        if (!root.getCanonicalPath().equals(item.optString("root"))) throw new IOException(t("此恢复记录属于其他项目。"));
        String path = item.getString("path"); byte[] current = read(safe(root, path));
        if (!item.optBoolean("completed")) throw new IOException(t("恢复未完成，请在终端检查已保存的副本：") + new File(backups, id + ".bin"));
        if (!hash(current).equals(item.getString("expectedAfter"))) throw new IOException(t("文件在恢复后再次变化，不会自动覆盖。"));
        byte[] saved = item.getBoolean("existed") ? Files.readAllBytes(new File(backups, id + ".bin").toPath()) : null;
        if (!hash(saved).equals(item.getString("sha256"))) throw new IOException(t("恢复副本校验失败。"));
        return remember(root, path, current, saved, null, t("还原到恢复之前的内容"));
    }
    private static void save(File file, JSONObject value) throws Exception { Utf8Files.write(file.toPath(), value.toString()); }
    private static String hash(byte[] data) { return data == null ? "missing" : WorkspacePath.hash(data); }
    private static String text(byte[] bytes) {
        if (bytes == null) return "";
        if (bytes.length > 1024 * 1024) return t("[大文件 · ") + bytes.length + " bytes]";
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            return text.indexOf('\0') < 0 ? text : t("[二进制文件 · ") + bytes.length + " bytes]";
        } catch (CharacterCodingException e) { return t("[二进制文件 · ") + bytes.length + " bytes]"; }
    }
    private static byte[] read(Path file) throws IOException {
        if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) return null;
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > LIMIT) throw new IOException(t("预览仅能恢复不超过 8 MiB 的普通文件。"));
        try (InputStream input = Files.newInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] block = new byte[8192]; int n;
            while ((n = input.read(block)) != -1) { if (out.size() + n > LIMIT) throw new IOException(t("文件大小已变化。")); out.write(block, 0, n); }
            return out.toByteArray();
        }
    }
    private static Path safe(File root, String name) throws IOException {
        if (name.isEmpty() || name.startsWith("/") || name.indexOf('\0') >= 0) throw new IOException(t("文件路径无效。"));
        Path base = root.getCanonicalFile().toPath(), current = base;
        for (String part : name.split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..") || part.equalsIgnoreCase(".git")) throw new IOException(t("不能恢复工作目录之外或 Git 内部的文件。"));
            current = current.resolve(part);
            if (Files.isSymbolicLink(current)) throw new IOException(t("恢复操作不会跟随符号链接。"));
        }
        return current;
    }
}
