package dev.mobilecodex.app;

import android.app.Application;
import android.content.Context;
import android.net.Uri;
import dev.mobilecodex.app.core.ProjectRegistry;
import dev.mobilecodex.app.core.WorkspacePath;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static dev.mobilecodex.app.core.Json.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 29, application = Application.class)
public class DocumentStoreGeneralSafetyTest {
    private Context context;
    private File fixture;
    private File outside;
    private static final String ROOT = "general-safety-fixture";

    @Before public void setup() throws Exception {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("projects", 0).edit().clear().commit();
        context.getSharedPreferences("workspace", 0).edit().clear().commit();
        fixture = new File(new File(context.getFilesDir(), "workspace"), ROOT);
        delete(fixture); assertTrue(fixture.mkdirs());
    }
    @After public void cleanup() throws Exception { delete(fixture); if (outside != null) Files.deleteIfExists(outside.toPath()); }

    private DocumentStore store() { return new DocumentStore(context); }
    private String path(String child) { return ROOT + "/" + child; }
    private static void delete(File value) throws Exception {
        if (!value.exists() && !Files.isSymbolicLink(value.toPath())) return;
        if (!Files.isSymbolicLink(value.toPath()) && value.isDirectory()) {
            File[] children = value.listFiles(); if (children != null) for (File child : children) delete(child);
        }
        Files.deleteIfExists(value.toPath());
    }

    @Test public void rejectsAbsoluteTraversalAndGeneralRootMutation() throws Exception {
        DocumentStore store = store();
        assertThrows(Exception.class, () -> store.read("../outside.txt"));
        assertThrows(Exception.class, () -> store.read("/outside.txt"));
        assertThrows(IOException.class, () -> store.prepare("mobile_delete", obj("path", "")));
        assertTrue(fixture.isDirectory());
    }

    @Test public void projectOutputIsCreatedOnBindingAndRestoredWhenAnOlderProjectIsOpened() throws Exception {
        DocumentStore store = store();
        store.createWorkspaceFolder(ROOT, "项目", false);
        File project = new File(fixture, "项目");
        File output = new File(project, "大肥龙输出");
        assertTrue(output.isDirectory());
        assertFalse(new File(fixture, "大肥龙输出").exists());
        File legacyOutput = new File(project, "输出");
        assertFalse(legacyOutput.exists());
        store.bindWorkspaceFolder(path("项目"), true);
        Files.delete(output.toPath());
        assertTrue(legacyOutput.mkdir());
        File legacyArtifact = new File(legacyOutput, "成品.txt");
        Files.write(legacyArtifact.toPath(), "旧成品".getBytes(StandardCharsets.UTF_8));

        DocumentStore reopened = store();
        JSONObject entry = reopened.list("").getJSONArray("entries").getJSONObject(0);
        assertEquals("大肥龙输出", entry.getString("path"));
        assertTrue(entry.getBoolean("directory"));
        assertEquals("旧成品", new String(Files.readAllBytes(legacyArtifact.toPath()), StandardCharsets.UTF_8));
        Files.delete(output.toPath());
        Files.write(output.toPath(), "保留内容".getBytes(StandardCharsets.UTF_8));
        reopened.list("");
        assertEquals("保留内容", new String(Files.readAllBytes(output.toPath()), StandardCharsets.UTF_8));
    }

    @Test public void workspacePickerScopesProjectsToRealFoldersUnderTheMainWorkspace() throws Exception {
        DocumentStore store = store();
        String project = path("项目 #1");
        File projectFolder = new File(fixture, "项目 #1");
        assertTrue(projectFolder.mkdir());
        Files.write(new File(projectFolder, "readme.txt").toPath(), new byte[] {65});
        Files.write(new File(fixture, "outside.txt").toPath(), new byte[] {66});
        assertTrue(new File(fixture, ".git").mkdir());
        outside = Files.createTempDirectory(context.getCacheDir().toPath(), "outside-workspace-").toFile();
        Files.createSymbolicLink(new File(fixture, "alias").toPath(), outside.toPath());

        JSONObject listing = store.workspaceFolders(ROOT);
        assertEquals("", listing.getString("parent"));
        assertEquals(1, listing.getJSONArray("entries").length());
        assertEquals(project, listing.getJSONArray("entries").getJSONObject(0).getString("path"));
        assertThrows(IllegalArgumentException.class, () -> store.bindWorkspaceFolder("../outside", true));
        assertThrows(IOException.class, () -> store.bindWorkspaceFolder(path("alias"), true));
        assertThrows(IOException.class, () -> store.createWorkspaceFolder(path(".git"), "bad", true));
        assertThrows(IOException.class, () -> store.createWorkspaceFolder(ROOT, "项目 #1", true));
        assertThrows(IOException.class, () -> store.createWorkspaceFolder(ROOT, "outside.txt", true));
        assertTrue(store.createWorkspaceFolder(ROOT, "新增", false).getBoolean("available"));
        assertTrue(new File(fixture, "新增").isDirectory());
        assertTrue(store.key().isEmpty());

        String key = store.bindWorkspaceFolder(project, true).getString("key");
        assertEquals(projectFolder.getCanonicalFile(), store.directDirectory());
        assertEquals("A", store.read("readme.txt").getString("content"));
        assertThrows(IOException.class, () -> store.read("outside.txt"));
        assertEquals(key, store().workspace().getString("key"));
        assertEquals("A", store().read("readme.txt").getString("content"));
    }

    @Test public void addingTheOriginalFolderDoesNotReplaceAnExistingReboundProject() throws Exception {
        ProjectRegistry registry = ProjectRegistry.fromJson("");
        String original = Uri.fromParts("workspace", ROOT, null).toString();
        String key = WorkspacePath.hash(original), replacement = "content://provider/tree/replacement";
        registry.put(replacement, "Rebound", key);
        context.getSharedPreferences("projects", 0).edit().putString("registry", registry.toJson()).commit();
        DocumentStore store = store();

        String newKey = store.bindWorkspaceFolder(ROOT, false).getString("key");
        assertNotEquals(key, newKey);
        assertEquals(key, store.key());
        assertEquals(newKey, store.bindWorkspaceFolder(ROOT, false).getString("key"));
        ProjectRegistry saved = ProjectRegistry.fromJson(context.getSharedPreferences("projects", 0).getString("registry", ""));
        assertEquals(replacement, saved.get(key).uri);
        assertEquals(original, saved.get(newKey).uri);
    }

    @Test public void previewRoutesDocumentsAndBinaryFilesWhileKeepingUtf8Editable() throws Exception {
        DocumentStore store = store();
        Files.write(new File(fixture, "report.PDF").toPath(), "%PDF-1.4".getBytes(StandardCharsets.UTF_8));
        Files.write(new File(fixture, "binary.dat").toPath(), new byte[] {0, 1, 2});
        Files.write(new File(fixture, "script.ts").toPath(), "const value = 1;".getBytes(StandardCharsets.UTF_8));
        assertTrue(store.preview(path("report.PDF")).getBoolean("openWithApp"));
        assertTrue(store.preview(path("binary.dat")).getBoolean("openWithApp"));
        assertEquals("const value = 1;", store.preview(path("script.ts")).getString("content"));
        assertThrows(Exception.class, () -> store.openTarget("../outside.txt"));
        assertThrows(IOException.class, () -> store.openTarget(ROOT));
    }

    @Test public void symlinkReadWriteAndRecursiveDeleteFailBeforeAnyLocalDeletion() throws Exception {
        outside = new File(context.getCacheDir(), "general-safety-outside.txt");
        Files.write(outside.toPath(), "outside".getBytes(StandardCharsets.UTF_8));
        File tree = new File(fixture, "tree"); assertTrue(tree.mkdir());
        File kept = new File(tree, "kept.txt"); Files.write(kept.toPath(), "keep".getBytes(StandardCharsets.UTF_8));
        Files.createSymbolicLink(new File(tree, "escape").toPath(), outside.toPath());
        DocumentStore store = store();
        assertThrows(IOException.class, () -> store.read(path("tree/escape")));
        assertThrows(IOException.class, () -> store.prepare("mobile_write", obj("path", path("tree/escape"), "content", "bad", "expectedSha256", "x")));
        assertThrows(IOException.class, () -> store.prepare("mobile_delete", obj("path", path("tree"))));
        // A link inserted while the user reviews a clean directory must also
        // fail at commit, before any sibling can be removed.
        Files.delete(new File(tree, "escape").toPath());
        DocumentStore.Mutation deletion = store.prepare("mobile_delete", obj("path", path("tree")));
        Files.createSymbolicLink(new File(tree, "escape").toPath(), outside.toPath());
        assertThrows(IOException.class, () -> store.commit(deletion));
        assertTrue("a nested symlink must abort before siblings are deleted", kept.isFile());
        assertTrue(tree.isDirectory()); assertEquals("outside", new String(Files.readAllBytes(outside.toPath()), StandardCharsets.UTF_8));
        Files.deleteIfExists(outside.toPath()); outside = null;
    }

    @Test public void staleWriteAndCreateOverwriteAreRejectedWithoutChangingBytes() throws Exception {
        File file = new File(fixture, "existing.txt"); Files.write(file.toPath(), "before".getBytes(StandardCharsets.UTF_8));
        DocumentStore store = store(); String item = path("existing.txt");
        assertThrows(IOException.class, () -> store.prepare("mobile_create", obj("path", item, "content", "replacement")));
        JSONObject read = store.read(item);
        DocumentStore.Mutation stale = store.prepare("mobile_write", obj("path", item, "content", "after", "expectedSha256", read.getString("sha256")));
        Files.write(file.toPath(), "external".getBytes(StandardCharsets.UTF_8));
        assertThrows(Exception.class, () -> store.commit(stale));
        assertEquals("external", new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
    }

    @Test public void smallWriteAndDeleteRecoveryRestoreOriginalBytes() throws Exception {
        File file = new File(fixture, "recover.txt"); Files.write(file.toPath(), "before".getBytes(StandardCharsets.UTF_8));
        DocumentStore store = store(); String item = path("recover.txt");
        JSONObject read = store.read(item);
        String writeRecovery = store.commit(store.prepare("mobile_write", obj("path", item, "content", "after", "expectedSha256", read.getString("sha256")))).getString("recoveryId");
        JSONObject preview = store.previewRecovery(writeRecovery); assertTrue(preview.getBoolean("canRestore"));
        JSONObject restore = store.recoveryMutation(writeRecovery);
        store.commit(store.prepare(restore.getString("operation"), restore.getJSONObject("arguments")));
        assertEquals("before", store.read(item).getString("content"));

        String deleteRecovery = store.commit(store.prepare("mobile_delete", obj("path", item))).getString("recoveryId");
        assertFalse(file.exists()); assertTrue(store.previewRecovery(deleteRecovery).getBoolean("canRestore"));
        restore = store.recoveryMutation(deleteRecovery);
        store.commit(store.prepare(restore.getString("operation"), restore.getJSONObject("arguments")));
        assertArrayEquals("before".getBytes(StandardCharsets.UTF_8), Files.readAllBytes(file.toPath()));
    }

    @Test public void mkdirListSearchRenameAndMovePreserveContent() throws Exception {
        DocumentStore store = store(); String folder = path("folder"), destination = path("destination");
        store.commit(store.prepare("mobile_mkdir", obj("path", folder)));
        store.commit(store.prepare("mobile_mkdir", obj("path", destination)));
        store.commit(store.prepare("mobile_create", obj("path", folder + "/alpha.txt", "content", "payload")));
        JSONArray listed = store.list(folder).getJSONArray("entries"); assertEquals("alpha.txt", listed.getJSONObject(0).getString("name"));
        assertEquals("alpha.txt", store.search("alpha").getJSONArray("entries").getJSONObject(0).getString("name"));
        store.commit(store.prepare("mobile_rename", obj("path", folder + "/alpha.txt", "name", "beta.txt")));
        store.commit(store.prepare("mobile_move", obj("path", folder + "/beta.txt", "destination", destination)));
        assertEquals("payload", store.read(destination + "/beta.txt").getString("content"));
    }
}
