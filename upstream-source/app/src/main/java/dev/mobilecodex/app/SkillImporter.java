package dev.mobilecodex.app;

import static dev.mobilecodex.app.core.Texts.t;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import java.io.*;
import java.nio.file.Files;
import java.util.*;
import dev.mobilecodex.app.core.WorkspacePath;

/** Copies a user-picked skill tree into Codex's own skills directory, preserving assets. */
public final class SkillImporter {
    private static final String[] COLUMNS = {Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE};
    private SkillImporter() {}
    public static String install(Context context, Uri tree) throws Exception {
        if (!DocumentsContract.isTreeUri(tree)) throw new IOException(t("请选择技能文件夹。"));
        String rootId = DocumentsContract.getTreeDocumentId(tree), name;
        Uri root = DocumentsContract.buildDocumentUriUsingTree(tree, rootId);
        try (Cursor c = context.getContentResolver().query(root, COLUMNS, null, null, null)) {
            if (c == null || !c.moveToFirst() || !Document.MIME_TYPE_DIR.equals(c.getString(2))) throw new IOException(t("无法打开文件夹。"));
            name = c.getString(1); WorkspacePath.checkName(name);
        }
        File skills = new File(CodexHome.open(context).root(), "skills");
        if (!skills.isDirectory() && !skills.mkdirs()) throw new IOException(t("无法创建技能存储空间。"));
        File target = new File(skills, name);
        if (target.exists()) throw new IOException(t("已存在同名技能，请编辑它或更换名称。"));
        File staging = new File(context.getCacheDir(), "skill-import-" + UUID.randomUUID());
        try {
            copy(context, tree, rootId, staging, new HashSet<>());
            if (!new File(staging, "SKILL.md").isFile()) throw new IOException(t("SKILL.md 必须直接位于所选文件夹中。"));
            Files.move(staging.toPath(), target.toPath());
            return target.getAbsolutePath();
        } finally { remove(staging); }
    }
    private static void copy(Context context, Uri tree, String id, File destination, Set<String> visited) throws Exception {
        if (!visited.add(id)) throw new IOException(t("技能文件夹存在循环路径。"));
        if (!destination.mkdirs()) throw new IOException(t("无法创建文件夹。"));
        List<String[]> entries = new ArrayList<>();
        try (Cursor c = context.getContentResolver().query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, id), COLUMNS, null, null, null)) {
            if (c == null) throw new IOException(t("无法读取技能文件夹。"));
            while (c.moveToNext()) entries.add(new String[]{c.getString(0), c.getString(1), c.getString(2)});
        }
        for (String[] entry : entries) {
            WorkspacePath.checkName(entry[1]); File output = new File(destination, entry[1]);
            if (output.exists()) throw new IOException(t("已存在同名项目：") + entry[1]);
            if (Document.MIME_TYPE_DIR.equals(entry[2])) copy(context, tree, entry[0], output, visited);
            else try (InputStream input = context.getContentResolver().openInputStream(DocumentsContract.buildDocumentUriUsingTree(tree, entry[0])); OutputStream out = new FileOutputStream(output)) {
                if (input == null) throw new IOException(t("无法读取文件。"));
                byte[] buffer = new byte[16384]; int n;
                while ((n = input.read(buffer)) != -1) out.write(buffer, 0, n);
            }
        }
    }
    private static void remove(File file) {
        File[] children = file.listFiles(); if (children != null) for (File child : children) remove(child);
        if (file.exists()) file.delete();
    }
}
