package dev.mobilecodex.app;

import static dev.mobilecodex.app.core.Texts.t;
import android.content.Context;
import java.io.*;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.*;

/** The app's Codex home, with a non-destructive migration from the pre-0.1.3 location. */
public final class CodexHome {
    public static final class Migration {
        public final int copied, conflicts, skippedEntries;
        Migration(int copied, int conflicts, int skippedEntries) {
            this.copied = copied; this.conflicts = conflicts; this.skippedEntries = skippedEntries;
        }
        public String notice() {
            if (conflicts > 0) return t("现有 Codex 数据：") + conflicts + t(" 个项目与新文件冲突，已保留在原位置。");
            if (copied > 0) return t("现有 Codex 设置和历史：") + copied + t(" 个项目已复制到新主目录。");
            return "";
        }
    }

    private final File root, legacy;
    private final Migration migration;

    private CodexHome(File root, File legacy, Migration migration) {
        this.root = root; this.legacy = legacy; this.migration = migration;
    }
    public static CodexHome open(Context context) throws IOException {
        File files = context.getFilesDir();
        File root = new File(files, ".codex"), legacy = new File(files, "codex");
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException(t("无法创建 Codex 主文件夹。"));
        int[] counts = new int[3];
        android.content.SharedPreferences migration = context.getSharedPreferences("codex-home-migration", 0);
        if (!migration.getBoolean("legacy-codex-copied", false)) {
            if (legacy.isDirectory()) copyMissing(legacy, root, counts);
            // Do not resurrect credentials or history from the legacy root after a user removes them from .codex.
            if (!migration.edit().putBoolean("legacy-codex-copied", true).commit()) {
                throw new IOException(t("无法保存 Codex 迁移状态。"));
            }
        }
        return new CodexHome(root.getCanonicalFile(), legacy.getCanonicalFile(), new Migration(counts[0], counts[1], counts[2]));
    }
    public File root() { return root; }
    /** The old directory remains in place, so older absolute config paths still resolve. */
    public File legacy() { return legacy; }
    public Migration migration() { return migration; }
    public File child(String name) throws IOException {
        if (name == null || name.isBlank() || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0) throw new IOException(t("Codex 主文件名无效。"));
        File file = new File(root, name).getCanonicalFile();
        if (!file.getParentFile().equals(root)) throw new IOException(t("不能使用 Codex 主目录之外的文件。"));
        return file;
    }
    private static void copyMissing(File source, File target, int[] counts) throws IOException {
        if (Files.isSymbolicLink(source.toPath())) {
            counts[2]++;
            return;
        }
        if (source.isDirectory()) {
            if (target.exists() && !target.isDirectory()) { counts[1]++; return; }
            if (!target.exists() && !target.mkdirs()) throw new IOException(t("无法移动原来的 Codex 文件夹。"));
            File[] entries = source.listFiles(); if (entries == null) throw new IOException(t("无法读取原来的 Codex 文件夹。"));
            for (File entry : entries) copyMissing(entry, new File(target, entry.getName()), counts);
            return;
        }
        if (!Files.isRegularFile(source.toPath())) {
            counts[2]++;
            return;
        }
        if (target.exists()) { counts[1]++; return; }
        File parent = target.getParentFile(); if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException(t("无法创建 Codex 主文件夹。"));
        File pending = new File(parent, "." + target.getName() + ".migration-" + UUID.randomUUID());
        boolean copied = false;
        try {
            try (InputStream in = new FileInputStream(source); OutputStream out = new FileOutputStream(pending)) {
                byte[] buffer = new byte[32768]; int count;
                while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
            }
            try { Files.move(pending.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE); }
            catch (java.nio.file.AtomicMoveNotSupportedException e) { Files.move(pending.toPath(), target.toPath()); }
            copied = true;
            counts[0]++;
        } finally {
            if (!copied) Files.deleteIfExists(pending.toPath());
        }
    }
}
