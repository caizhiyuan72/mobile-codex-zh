package dev.mobilecodex.app;

import static dev.mobilecodex.app.core.Texts.t;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.UUID;
import static dev.mobilecodex.app.core.Json.*;

/** Reads and updates the actual global AGENTS file selected by Codex precedence. */
final class PersonalInstructions {
    private final CodexHome home;
    PersonalInstructions(CodexHome home) { this.home = home; }
    JSONObject read() throws Exception {
        File base = home.child("AGENTS.md"), override = home.child("AGENTS.override.md");
        boolean overridden = override.isFile() && !readFile(override).isBlank();
        File active = overridden ? override : base;
        return obj("content", active.isFile() ? readFile(active) : "", "path", active.getAbsolutePath(),
            "activePath", active.getAbsolutePath(), "basePath", base.getAbsolutePath(), "overridden", overridden,
            "notice", overridden ? t("AGENTS.override.md 已启用，你正在编辑该文件。") : home.migration().notice());
    }
    JSONObject save(String content) throws Exception {
        if (content == null) throw new IOException(t("无法读取指令。"));
        if (content.getBytes(StandardCharsets.UTF_8).length > 64 * 1024) throw new IOException(t("个人指令最多可保存 64 KiB。"));
        JSONObject before = read(); File target = new File(before.getString("activePath"));
        writeAtomically(target, content);
        JSONObject after = read();
        if (target.getName().equals("AGENTS.override.md") && content.isBlank() && !after.optBoolean("overridden"))
            after.put("notice", t("AGENTS.override.md 已清空，已重新启用 AGENTS.md。"));
        return after;
    }
    private static String readFile(File file) throws IOException {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }
    static void writeAtomically(File target, String content) throws IOException {
        File parent = target.getParentFile();
        if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException(t("无法创建个人指令文件夹。"));
        File pending = new File(parent, "." + target.getName() + ".pending-" + UUID.randomUUID());
        try {
            Files.write(pending.toPath(), content.getBytes(StandardCharsets.UTF_8));
            try { Files.move(pending.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
            catch (java.nio.file.AtomicMoveNotSupportedException e) { Files.move(pending.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING); }
        } finally { Files.deleteIfExists(pending.toPath()); }
    }
}
