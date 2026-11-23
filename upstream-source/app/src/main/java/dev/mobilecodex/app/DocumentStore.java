package dev.mobilecodex.app;

import static dev.mobilecodex.app.core.Texts.t;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.os.Environment;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import dev.mobilecodex.app.core.ProjectRegistry;
import dev.mobilecodex.app.core.WorkspacePath;
import static dev.mobilecodex.app.core.Json.*;

/** Workspace operations for app folders and SAF trees. */
public final class DocumentStore {
    public static final int TEXT_LIMIT = 1024 * 1024;
    private static final int BACKUP_LIMIT = 32 * 1024 * 1024;
    private static final String WORKSPACE_SCHEME = "workspace";
    private static final String OUTPUT_FOLDER = "大肥龙输出";
    private final Context context;
    private Uri tree;
    private String label = t("Codex");
    private ProjectRegistry projects;
    private final File backups, generalRoot;
    private static final String[] COLUMNS = {Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME,
        Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS};

    public DocumentStore(Context context) {
        this.context = context;
        backups = new File(context.getFilesDir(), "recovery");
        backups.mkdirs();
        // Preserve the long-standing physical workspace path so an upgrade never
        // hides or moves existing files. Only its display name follows the app brand.
        generalRoot = new File(context.getFilesDir(), "workspace");
        generalRoot.mkdirs();
        String registry = context.getSharedPreferences("projects", 0).getString("registry", "");
        projects = ProjectRegistry.fromJson(registry);
        // Migrate the old single-folder preference into the multi-project registry once.
        String saved = context.getSharedPreferences("workspace", 0).getString("uri", "");
        boolean legacyDeferred = false;
        if (registry.isBlank() && !saved.isEmpty()) {
            try {
                Uri uri = Uri.parse(saved); Node node = query(documentUri(uri));
                ProjectRegistry staged = ProjectRegistry.fromJson(projects.toJson());
                staged.put(uri.toString(), node.name, WorkspacePath.hash(uri.toString())); projects = staged;
            } catch (Exception ignored) { legacyDeferred = true; }
        }
        if (!legacyDeferred && (registry.isBlank() || !dev.mobilecodex.app.core.Json.parse(registry).has("identities"))) {
            android.content.SharedPreferences.Editor migration = context.getSharedPreferences("projects", 0).edit();
            if (!registry.isBlank()) migration.putString("registry-before-identities-v1", registry);
            if (!migration.putString("registry", projects.toJson()).commit())
                throw new IllegalStateException(t("无法保存项目列表的更改。"));
        }
        if (!legacyDeferred && !registry.isBlank() && dev.mobilecodex.app.core.Json.parse(registry).has("identities")
            && !dev.mobilecodex.app.core.Json.parse(registry).optJSONObject("identities").has("history")) {
            if (!context.getSharedPreferences("projects", 0).edit().putString("registry-before-portable-v1", registry)
                .putString("registry", projects.toJson()).commit()) throw new IllegalStateException(t("无法保存项目列表的更改。"));
        }
        try { activate(projects.selected()); } catch (Exception ignored) { tree = null; }
    }
    public synchronized JSONObject select(Uri uri) throws Exception { return select(uri, ""); }
    /** Registers a new project or reconnects the stable project key to a replacement SAF URI. */
    public synchronized JSONObject select(Uri uri, String projectKey) throws Exception {
        return select(uri, projectKey, true);
    }
    synchronized JSONObject select(Uri uri, String projectKey, boolean select) throws Exception {
        if (!"content".equals(uri.getScheme()) || !DocumentsContract.isTreeUri(uri))
            throw new IllegalArgumentException(t("请选择文件夹。"));
        Node selected = query(documentUri(uri));
        if (!selected.directory()) throw new IOException(t("这不是文件夹。"));
        ProjectRegistry staged = ProjectRegistry.fromJson(projects.toJson());
        ProjectRegistry.Project project = stageFolderBinding(staged, uri.toString(), selected.name, projectKey);
        JSONObject result = saveProject(staged, project, select, uri);
        if (canCreateOutput(selected)) {
            try { ensureDocumentOutput(selected, children(selected)); }
            catch (IOException | RuntimeException ignored) { }
        }
        if (select) context.getSharedPreferences("workspace", 0).edit().putString("uri", uri.toString()).apply();
        return result;
    }
    /** Switches among stored projects without asking Android's picker again. Empty selects general chat. */
    public synchronized void selectProject(String key) throws Exception {
        key = key == null ? "" : key;
        // Old callbacks or sessions can still mention a tombstoned binding. It is
        // now the general workspace rather than a detached pseudo-project.
        if (projects.removed(key)) key = "";
        if (!key.equals(projects.selectedKey())) {
            ProjectRegistry staged = ProjectRegistry.fromJson(projects.toJson());
            staged.select(key);
            commitProjects(staged);
        }
        ProjectRegistry.Project project = projects.selected();
        tree = null; label = project == null ? t("Codex") : project.name;
        if (isWorkspaceBinding(project)) {
            try { ensureLocalOutput(workspaceBindingFolder(project)); }
            catch (IOException ignored) { }
        }
        try { activate(project); } catch (Exception ignored) { tree = null; }
    }
    public synchronized JSONArray projects() {
        java.util.Set<Uri> readable = new java.util.HashSet<>();
        try {
            for (android.content.UriPermission permission : context.getContentResolver().getPersistedUriPermissions())
                if (permission.isReadPermission()) readable.add(permission.getUri());
        } catch (Exception ignored) { }
        return projects.entries(project -> isWorkspaceBinding(project) ? workspaceFolderAvailable(project)
            : !project.uri.isBlank() && readable.contains(Uri.parse(project.uri)));
    }
    public synchronized String projectId(String key) { return projects.projectId(key); }
    public synchronized JSONObject exportProject(String key) { return projects.exportProject(key); }
    public synchronized JSONObject previewProjects(String raw) {
        ProjectRegistry staged = ProjectRegistry.fromJson(projects.toJson());
        JSONObject result = staged.importProjects(raw);
        return obj("result", result, "projects", staged.entries(this::available), "token", WorkspacePath.hash(projects.toJson() + "\n" + raw));
    }
    public synchronized JSONObject importProjects(String raw, String token) throws IOException {
        if (!WorkspacePath.hash(projects.toJson() + "\n" + raw).equals(token)) throw new IllegalArgumentException(t("项目列表已变更，请重新导入文件。"));
        ProjectRegistry staged = ProjectRegistry.fromJson(projects.toJson()); staged.importProjects(raw);
        commitProjects(staged);
        if (!projects.selectedKey().isBlank()) label = projects.displayName(projects.selectedKey());
        return obj("projects", projects(), "workspace", workspace());
    }
    public synchronized JSONObject createProject(String name) throws IOException {
        return createProject(name, true);
    }
    synchronized JSONObject createProject(String name, boolean select) throws IOException {
        ProjectRegistry staged = ProjectRegistry.fromJson(projects.toJson());
        return saveProject(staged, staged.createUnbound(name), select, null);
    }
    synchronized JSONObject workspaceFolders(String path) throws IOException {
        File directory = workspaceFolder(path);
        JSONArray entries = new JSONArray();
        for (File child : localChildren(directory)) {
            String name = child.getName();
            if (name.equals(".git") || Files.isSymbolicLink(child.toPath()) || !child.isDirectory() || !child.canRead()) continue;
            String relative = path.isEmpty() ? name : path + "/" + name;
            try { WorkspacePath.segments(relative); }
            catch (IllegalArgumentException ignored) { continue; }
            entries.put(obj("name", name, "path", relative));
        }
        String rootName = context.getApplicationInfo().loadLabel(context.getPackageManager()).toString();
        return obj("rootName", rootName, "path", path, "parent", path.isEmpty() ? JSONObject.NULL : WorkspacePath.parent(path), "entries", entries);
    }
    synchronized JSONObject bindWorkspaceFolder(String path, boolean select) throws IOException {
        if (path.isEmpty()) throw new IllegalArgumentException(t("请选择文件夹。"));
        return saveWorkspaceBinding(path, workspaceFolder(path), select);
    }
    synchronized JSONObject createWorkspaceFolder(String path, String name, boolean select) throws IOException {
        String clean = name.trim();
        WorkspacePath.checkName(clean);
        workspaceFolder(path);
        String relative = path.isEmpty() ? clean : path + "/" + clean;
        requireMutableLocalPath(relative);
        File directory = resolveLocal(safeGeneralRoot(), relative);
        try { Files.createDirectory(directory.toPath()); }
        catch (java.nio.file.FileAlreadyExistsException error) {
            throw new IOException(t("已存在同名文件或文件夹。"), error);
        }
        return saveWorkspaceBinding(relative, directory, select);
    }
    private JSONObject saveWorkspaceBinding(String path, File directory, boolean select) throws IOException {
        String binding = Uri.fromParts(WORKSPACE_SCHEME, path, null).toString();
        ProjectRegistry staged = ProjectRegistry.fromJson(projects.toJson());
        JSONObject result = saveProject(staged, stageFolderBinding(staged, binding, directory.getName(), ""), select, null);
        ensureLocalOutput(directory);
        return result;
    }
    private ProjectRegistry.Project stageFolderBinding(ProjectRegistry staged, String uri, String name, String key) {
        if (key == null || key.isBlank()) {
            ProjectRegistry.Project bound = staged.boundTo(uri);
            if (bound != null) { staged.select(bound.key); return bound; }
            key = WorkspacePath.hash(uri);
            if (staged.get(key) != null) key = "local_" + UUID.randomUUID();
        }
        ProjectRegistry.Project existing = staged.get(key);
        return staged.put(uri, existing == null ? name : existing.name, key);
    }
    private JSONObject saveProject(ProjectRegistry staged, ProjectRegistry.Project project, boolean select, Uri uri) throws IOException {
        if (!select) staged.select(projects.selectedKey());
        commitProjects(staged);
        if (select) { tree = uri; label = projects.displayName(project.key); }
        return projectWorkspace(project, available(project));
    }
    public synchronized JSONObject mergeProjects(String sourceKey, String targetKey) throws IOException {
        ProjectRegistry staged = ProjectRegistry.fromJson(projects.toJson());
        String projectId = staged.merge(sourceKey, targetKey);
        commitProjects(staged);
        if (!projects.selectedKey().isBlank()) label = projects.displayName(projects.selectedKey());
        return obj("projectId", projectId, "projects", projects());
    }
    public synchronized JSONObject preferProject(String key) throws IOException {
        ProjectRegistry staged = ProjectRegistry.fromJson(projects.toJson());
        staged.prefer(key);
        commitProjects(staged);
        return obj("projects", projects());
    }
    private void commitProjects(ProjectRegistry staged) throws IOException {
        if (!context.getSharedPreferences("projects", 0).edit().putString("registry", staged.toJson()).commit())
            throw new IOException(t("无法保存项目列表的更改。"));
        projects = staged;
    }
    /** Removes only the registry entry. The underlying SAF folder and its files are untouched. */
    public synchronized JSONObject removeProject(String key) throws IOException {
        ProjectRegistry staged = ProjectRegistry.fromJson(projects.toJson());
        boolean current = key != null && key.equals(projects.selectedKey());
        ProjectRegistry.Project removed = staged.remove(key);
        commitProjects(staged);
        if (current) { tree = null; label = t("Codex"); }
        return obj("key", removed.key, "name", removed.name);
    }
    /** Persists a display-name change without renaming the physical folder or changing its key. */
    public synchronized JSONObject renameProject(String key, String name) throws IOException {
        ProjectRegistry staged = ProjectRegistry.fromJson(projects.toJson());
        ProjectRegistry.Project renamed = staged.rename(key, name);
        commitProjects(staged);
        if (!projects.selectedKey().isBlank()) label = projects.displayName(projects.selectedKey());
        return obj("key", renamed.key, "name", renamed.name);
    }
    public synchronized String restoreProjectKey(String sessionId, String oldKey, String oldName) {
        String before = projects.toJson();
        ProjectRegistry staged = ProjectRegistry.fromJson(before);
        String key = staged.restoreLegacyKey(sessionId, oldKey, oldName);
        if (!before.equals(staged.toJson())) {
            try { commitProjects(staged); }
            catch (IOException error) { throw new IllegalStateException(error.getMessage(), error); }
        }
        return key;
    }
    private Uri documentUri(Uri value) {
        return DocumentsContract.buildDocumentUriUsingTree(value, DocumentsContract.getTreeDocumentId(value));
    }
    private boolean available(ProjectRegistry.Project project) {
        if (project == null) return true;
        if (project.uri.isBlank()) return false;
        if (isWorkspaceBinding(project)) return workspaceFolderAvailable(project);
        try {
            Uri uri = Uri.parse(project.uri);
            for (android.content.UriPermission permission : context.getContentResolver().getPersistedUriPermissions())
                if (permission.isReadPermission() && permission.getUri().equals(uri)) return true;
        } catch (Exception ignored) { }
        return false;
    }
    private void activate(ProjectRegistry.Project project) throws Exception {
        if (project == null || isWorkspaceBinding(project) || !available(project)) return;
        Uri uri = Uri.parse(project.uri); Node selected = query(documentUri(uri));
        if (!selected.directory()) throw new IOException(t("这不是文件夹。"));
        tree = uri; label = project.name;
    }
    public synchronized JSONObject workspace() {
        ProjectRegistry.Project project = projects.selected();
        if (project == null) return obj("selected", false, "name", t("Codex"), "key", "", "projectId", "",
            "hasLocalFolder", true, "available", generalAvailable(), "defaultWorkspace", true);
        return projectWorkspace(project, (isWorkspaceBinding(project) || tree != null) && available(project));
    }
    private JSONObject projectWorkspace(ProjectRegistry.Project project, boolean available) {
        return obj("selected", true, "name", projects.displayName(project.key),
            "key", project.key, "projectId", projects.projectId(project.key), "hasLocalFolder", !project.uri.isBlank(), "available", available);
    }
    public synchronized String key() { return projects.selectedKey(); }
    public synchronized void requireWorkspaceAvailable() throws IOException {
        ProjectRegistry.Project project = projects.selected();
        if (project == null) {
            if ((!generalRoot.isDirectory() && !generalRoot.mkdirs()) || !generalRoot.canRead())
                throw new IOException(t("无法打开 Codex 工作目录。"));
            safeGeneralRoot();
            return;
        }
        try {
            if (isWorkspaceBinding(project)) workspaceBindingFolder(project);
            else {
                if (tree == null || !available(project) || !query(documentUri(tree)).directory())
                    throw new IOException(t("无法打开工作文件夹。"));
            }
        } catch (Exception e) {
            tree = null;
            throw new IOException(t("无法访问此项目文件夹，请在项目列表中重新关联。"), e);
        }
    }
    /** Makes a project-relative mention reachable by Codex, copying SAF-only files into app storage. */
    synchronized JSONObject mention(String path, AttachmentStore attachments) throws Exception {
        if (localSelected()) {
            File value = local(path);
            if (!value.isFile()) throw new IOException(value.isDirectory() ? t("不能将文件夹作为对话附件。") : t("无法读取文件。"));
            return obj("name", value.getName(), "path", value.getAbsolutePath());
        }
        Node node = resolve(path);
        if (node.directory()) throw new IOException(t("不能将文件夹作为对话附件。"));
        File direct = directDirectory();
        if (direct != null) {
            File local = new File(direct, path).getCanonicalFile();
            if (!local.getPath().startsWith(direct.getCanonicalPath() + File.separator) || !local.isFile())
                throw new IOException(t("无法读取文件。"));
            return obj("name", node.name, "path", local.getAbsolutePath());
        }
        try (InputStream in = context.getContentResolver().openInputStream(node.uri)) {
            if (in == null) throw new IOException(t("无法读取文件。"));
            JSONObject stored = attachments.store(in, node.name, node.mime);
            return obj("name", node.name, "path", stored.getString("path"));
        }
    }
    synchronized JSONObject image(String path, ImageStore images) throws Exception {
        if (localSelected()) {
            File value = local(path);
            if (!value.isFile()) throw new IOException(t("请选择图片文件。"));
            try (InputStream in = new FileInputStream(value)) { return images.store(in, value.getName()); }
        }
        Node n = resolve(path);
        if (n.directory()) throw new IOException(t("请选择图片文件。"));
        try (InputStream in = context.getContentResolver().openInputStream(n.uri)) {
            if (in == null) throw new IOException(t("无法读取图片文件。"));
            return images.store(in, n.name);
        }
    }
    /** Primary-storage document trees have a documented volume:relative-path ID. */
    public synchronized File directDirectory() {
        if (!workspace().optBoolean("available")) return null;
        if (localSelected()) {
            try { return localRoot(); }
            catch (IOException ignored) { return null; }
        }
        if (tree == null || !"com.android.externalstorage.documents".equals(tree.getAuthority())) return null;
        try {
            String id = DocumentsContract.getTreeDocumentId(tree);
            int separator = id.indexOf(':');
            if (separator < 0) return null;
            String volume = id.substring(0, separator), relative = id.substring(separator + 1);
            WorkspacePath.segments(relative);
            File root;
            if (volume.equals("primary")) root = Environment.getExternalStorageDirectory().getCanonicalFile();
            else if (volume.equals("home")) root = new File(Environment.getExternalStorageDirectory(), "Documents").getCanonicalFile();
            else if (volume.matches("[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}")) root = new File("/storage", volume).getCanonicalFile();
            else return null;
            File folder = new File(root, relative).getCanonicalFile();
            if (!(folder.equals(root) || folder.getPath().startsWith(root.getPath() + File.separator))) return null;
            return folder.isDirectory() && folder.canRead() ? folder : null;
        } catch (Exception ignored) { return null; }
    }
    private void requireTree() throws IOException {
        requireWorkspaceAvailable();
        if (tree == null) throw new IOException(t("请先选择工作文件夹。"));
    }

    private static boolean isWorkspaceBinding(ProjectRegistry.Project project) {
        return project != null && project.uri.startsWith(WORKSPACE_SCHEME + ":");
    }
    private boolean localSelected() { return projects.selected() == null || isWorkspaceBinding(projects.selected()); }
    private File workspaceFolder(String path) throws IOException {
        requireMutableLocalPath(path);
        File folder = resolveLocal(safeGeneralRoot(), path);
        if (!folder.isDirectory() || !folder.canRead()) throw new IOException(t("无法打开工作文件夹。"));
        return folder;
    }
    private File workspaceBindingFolder(ProjectRegistry.Project project) throws IOException {
        String path = Uri.parse(project.uri).getSchemeSpecificPart();
        if (path == null || path.isEmpty()) throw new IOException(t("无法打开工作文件夹。"));
        return workspaceFolder(path);
    }
    private boolean workspaceFolderAvailable(ProjectRegistry.Project project) {
        try { workspaceBindingFolder(project); return true; }
        catch (IllegalArgumentException | IOException ignored) { return false; }
    }
    private File localRoot() throws IOException {
        ProjectRegistry.Project project = projects.selected();
        return project == null ? safeGeneralRoot() : workspaceBindingFolder(project);
    }
    private boolean generalAvailable() {
        try { return generalRoot.isDirectory() && generalRoot.canRead() && safeGeneralRoot().isDirectory(); }
        catch (IOException ignored) { return false; }
    }
    private File safeGeneralRoot() throws IOException {
        if (Files.isSymbolicLink(generalRoot.toPath()))
            throw new IOException(t("Codex 工作目录不能是符号链接。"));
        File files = context.getFilesDir().getCanonicalFile(), root = generalRoot.getCanonicalFile();
        if (!root.getPath().startsWith(files.getPath() + File.separator))
            throw new IOException(t("Codex 工作目录路径无效。"));
        return root;
    }
    private File local(String path) throws IOException { return resolveLocal(localRoot(), path); }
    private File resolveLocal(File root, String path) throws IOException {
        List<String> segments = WorkspacePath.segments(path);
        File unresolved = root;
        for (String segment : segments) {
            unresolved = new File(unresolved, segment);
            if (Files.isSymbolicLink(unresolved.toPath())) throw new IOException(t("无法在文件面板中打开符号链接。"));
        }
        File value = unresolved.getCanonicalFile();
        if (!(value.equals(root) || value.getPath().startsWith(root.getPath() + File.separator)))
            throw new IOException(t("只能使用 Codex 工作目录内的路径。"));
        return value;
    }
    private JSONObject localJson(File value, String path) throws IOException {
        boolean directory = value.isDirectory();
        String mime = directory ? Document.MIME_TYPE_DIR : Files.probeContentType(value.toPath());
        if (mime == null) mime = "application/octet-stream";
        return obj("name", value.getName(), "path", path, "directory", directory, "mime", mime,
            "size", directory ? 0 : value.length(), "modified", value.lastModified());
    }
    private List<File> localChildren(File parent) throws IOException {
        if (!parent.isDirectory()) throw new IOException(t("这不是文件夹。"));
        File[] values = parent.listFiles();
        if (values == null) throw new IOException(t("无法打开文件夹。"));
        if (values.length > 5000) throw new IOException(t("此文件夹包含超过 5,000 个项目，请选择更小的文件夹。"));
        ArrayList<File> result = new ArrayList<>(Arrays.asList(values));
        result.sort(Comparator.comparing((File value) -> Files.isSymbolicLink(value.toPath()) || !value.isDirectory())
            .thenComparing(value -> value.getName().toLowerCase(Locale.ROOT)));
        return result;
    }
    private byte[] localBytes(File value, int limit) throws IOException {
        if (!value.isFile()) throw new IOException(value.isDirectory() ? t("不能将文件夹作为文本打开。") : t("找不到文件。"));
        checkPreviewSize(value.length(), limit);
        try (InputStream in = new FileInputStream(value)) { return readBounded(in, limit); }
    }
    private Node query(Uri uri) throws IOException {
        try (Cursor c = context.getContentResolver().query(uri, COLUMNS, null, null, null)) {
            if (c == null || !c.moveToFirst()) throw new FileNotFoundException(t("找不到文件。"));
            return new Node(uri, c.getString(0), c.getString(1), c.getString(2), c.getLong(3), c.getLong(4), c.getInt(5));
        }
    }
    private Node root() throws IOException {
        requireTree();
        return query(DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree)));
    }
    private List<Node> children(Node parent) throws IOException {
        if (!parent.directory()) throw new IOException(t("这不是文件夹。"));
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(parent.uri, parent.id);
        ArrayList<Node> result = new ArrayList<>();
        try (Cursor c = context.getContentResolver().query(children, COLUMNS, null, null, null)) {
            if (c == null) throw new IOException(t("无法打开文件夹。"));
            while (c.moveToNext()) {
                if (result.size() >= 5000) throw new IOException(t("此文件夹包含超过 5,000 个项目，请选择更小的文件夹。"));
                result.add(new Node(DocumentsContract.buildDocumentUriUsingTree(parent.uri, c.getString(0)),
                    c.getString(0), c.getString(1), c.getString(2), c.getLong(3), c.getLong(4), c.getInt(5)));
            }
        }
        result.sort(Comparator.comparing((Node n) -> !n.directory()).thenComparing(n -> n.name.toLowerCase(Locale.ROOT)));
        return result;
    }
    private Node resolve(String path) throws IOException {
        Node n = root();
        for (String segment : WorkspacePath.segments(path)) {
            Node found = null;
            for (Node child : children(n)) {
                if (child.name.equals(segment)) {
                    if (found != null) throw new IOException(t("多个项目具有相同名称：") + segment);
                    found = child;
                }
            }
            if (found == null) throw new FileNotFoundException(t("找不到文件：") + path);
            n = found;
        }
        return n;
    }
    private boolean exists(String path) throws IOException {
        try { resolve(path); return true; } catch (FileNotFoundException e) { return false; }
    }
    private void ensureLocalOutput(File parent) {
        var output = new File(parent, OUTPUT_FOLDER).toPath();
        if (Files.exists(output, java.nio.file.LinkOption.NOFOLLOW_LINKS)) return;
        try { Files.createDirectory(output); }
        catch (IOException | SecurityException ignored) { }
    }
    private boolean canCreateOutput(Node parent) {
        return (parent.flags & Document.FLAG_DIR_SUPPORTS_CREATE) != 0;
    }
    private Node ensureDocumentOutput(Node parent, List<Node> entries) {
        if (!canCreateOutput(parent)) return null;
        for (Node entry : entries) if (OUTPUT_FOLDER.equals(entry.name)) return null;
        try {
            Uri created = DocumentsContract.createDocument(context.getContentResolver(), parent.uri, Document.MIME_TYPE_DIR, OUTPUT_FOLDER);
            return created == null ? null : query(created);
        } catch (IOException | RuntimeException ignored) { return null; }
    }
    public synchronized JSONObject list(String path) throws IOException {
        if (localSelected()) {
            JSONArray entries = new JSONArray();
            File parent = local(path);
            if (path.isEmpty() && projects.selected() != null) ensureLocalOutput(parent);
            for (File value : localChildren(parent)) {
                String childPath = path.isEmpty() ? value.getName() : path + "/" + value.getName();
                // Resolve through the canonical boundary before exposing an entry.
                try { entries.put(localJson(local(childPath), childPath)); }
                catch (IOException ignored) { }
            }
            return obj("path", path, "entries", entries);
        }
        Node parent = resolve(path);
        List<Node> children = children(parent);
        if (path.isEmpty()) {
            Node output = ensureDocumentOutput(parent, children);
            if (output != null) {
                children.add(output);
                children.sort(Comparator.comparing((Node node) -> !node.directory()).thenComparing(node -> node.name.toLowerCase(Locale.ROOT)));
            }
        }
        JSONArray entries = new JSONArray();
        for (Node n : children) entries.put(n.json(path.isEmpty() ? n.name : path + "/" + n.name));
        return obj("path", path, "entries", entries);
    }
    public synchronized JSONObject search(String text) throws IOException {
        if (text == null || text.isBlank()) throw new IllegalArgumentException(t("请输入搜索关键词。"));
        if (localSelected()) return searchLocal(text);
        String needle = text.toLowerCase(Locale.ROOT);
        ArrayDeque<String> queue = new ArrayDeque<>();
        queue.add("");
        HashSet<String> seen = new HashSet<>();
        JSONArray results = new JSONArray();
        int visited = 0;
        while (!queue.isEmpty() && visited < 3000 && results.length() < 200) {
            String path = queue.remove();
            Node parent = resolve(path);
            if (!seen.add(parent.id)) continue;
            for (Node n : children(parent)) {
                if (++visited > 3000) break;
                String childPath = path.isEmpty() ? n.name : path + "/" + n.name;
                if (n.name.toLowerCase(Locale.ROOT).contains(needle)) results.put(n.json(childPath));
                if (n.directory() && WorkspacePath.segments(childPath).size() < 32) queue.add(childPath);
                if (results.length() >= 200) break;
            }
        }
        return obj("entries", results, "truncated", !queue.isEmpty() || visited >= 3000 || results.length() >= 200);
    }
    private JSONObject searchLocal(String text) throws IOException {
        String needle = text.toLowerCase(Locale.ROOT);
        ArrayDeque<String> queue = new ArrayDeque<>(); queue.add("");
        HashSet<String> seen = new HashSet<>(); JSONArray results = new JSONArray(); int visited = 0;
        while (!queue.isEmpty() && visited < 3000 && results.length() < 200) {
            String path = queue.remove(); File parent = local(path);
            if (!seen.add(parent.getCanonicalPath())) continue;
            for (File child : localChildren(parent)) {
                if (++visited > 3000) break;
                String childPath = path.isEmpty() ? child.getName() : path + "/" + child.getName();
                File bounded;
                try { bounded = local(childPath); } catch (IOException ignored) { continue; }
                if (child.getName().toLowerCase(Locale.ROOT).contains(needle)) results.put(localJson(bounded, childPath));
                if (bounded.isDirectory() && WorkspacePath.segments(childPath).size() < 32) queue.add(childPath);
                if (results.length() >= 200) break;
            }
        }
        return obj("entries", results, "truncated", !queue.isEmpty() || visited >= 3000 || results.length() >= 200);
    }
    private byte[] bytes(Node n, int limit) throws IOException {
        if (n.directory()) throw new IOException(t("不能将文件夹作为文本打开。"));
        checkPreviewSize(n.size, limit);
        try (InputStream in = context.getContentResolver().openInputStream(n.uri)) {
            if (in == null) throw new IOException(t("无法读取文件。"));
            return readBounded(in, limit);
        }
    }
    private static final class PreviewUnavailable extends IOException {
        PreviewUnavailable(String message) { super(message); }
    }
    private static void checkPreviewSize(long size, int limit) throws IOException {
        if (size > limit) throw new PreviewUnavailable(t("超出文件大小限制（") + (limit / 1024 / 1024) + " MiB).");
    }
    private static byte[] readBounded(InputStream in, int limit) throws IOException {
        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = in.read(buffer)) != -1) {
                checkPreviewSize((long) out.size() + count, limit);
                out.write(buffer, 0, count);
            }
            return out.toByteArray();
        }
    }
    private String decode(byte[] data) throws IOException {
        try {
            String value = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(data)).toString();
            if (value.indexOf('\0') >= 0) throw new PreviewUnavailable(t("不是文本文件。"));
            return value;
        } catch (CharacterCodingException e) { throw new PreviewUnavailable(t("只能编辑 UTF-8 文本文件。")); }
    }
    public synchronized JSONObject read(String path) throws IOException {
        if (localSelected()) {
            byte[] data = localBytes(local(path), TEXT_LIMIT);
            return obj("path", path, "content", decode(data), "sha256", WorkspacePath.hash(data));
        }
        byte[] data = bytes(resolve(path), TEXT_LIMIT);
        return obj("path", path, "content", decode(data), "sha256", WorkspacePath.hash(data));
    }
    synchronized JSONObject preview(String path) throws IOException {
        try {
            byte[] data;
            if (localSelected()) {
                File file = local(path);
                if (file.isFile() && FileOpenTarget.prefersViewer(FileOpenTarget.mimeFor(file.getName(), null)))
                    return obj("openWithApp", true);
                data = localBytes(file, TEXT_LIMIT);
            } else {
                Node node = resolve(path);
                if (!node.directory() && FileOpenTarget.prefersViewer(FileOpenTarget.mimeFor(node.name, node.mime)))
                    return obj("openWithApp", true);
                data = bytes(node, TEXT_LIMIT);
            }
            return obj("path", path, "content", decode(data), "sha256", WorkspacePath.hash(data));
        } catch (PreviewUnavailable unsupported) { return obj("openWithApp", true); }
    }
    synchronized FileOpenTarget openTarget(String path) throws IOException {
        if (localSelected()) {
            File file = local(path);
            if (!file.isFile() || !file.canRead()) throw new IOException(t("无法读取文件。"));
            Uri uri = WorkspaceFileProvider.getUriForFile(context, context.getPackageName() + ".workspace-files", file);
            return new FileOpenTarget(uri, file.getName(), FileOpenTarget.mimeFor(file.getName(), null));
        }
        Node node = resolve(path);
        if (node.directory()) throw new IOException(t("无法读取文件。"));
        return new FileOpenTarget(node.uri, node.name, FileOpenTarget.mimeFor(node.name, node.mime));
    }
    public synchronized Mutation prepare(String operation, JSONObject args) throws Exception {
        if (localSelected()) return prepareLocal(operation, args);
        requireTree();
        String path = args.getString("path");
        WorkspacePath.segments(path);
        if (path.isEmpty()) throw new IOException(t("不能修改工作文件夹本身。"));
        Node n = null;
        byte[] before = null;
        String title;
        String preview = path;
        if (operation.equals("mobile_create") || operation.equals("mobile_mkdir")) {
            if (exists(path)) throw new IOException(t("已存在同名文件或文件夹。"));
            if (!resolve(WorkspacePath.parent(path)).directory()) throw new IOException(t("上级文件夹不存在。"));
            title = operation.equals("mobile_create") ? t("创建文件") : t("创建文件夹");
        } else {
            n = resolve(path);
            title = switch (operation) {
                case "mobile_write" -> t("编辑文件");
                case "mobile_delete" -> t("删除文件");
                case "mobile_rename" -> t("重命名");
                case "mobile_move" -> t("移动文件");
                default -> throw new IOException(t("不支持的操作。"));
            };
        }
        if (operation.equals("mobile_write")) {
            before = bytes(n, TEXT_LIMIT);
            WorkspacePath.requireVersion(args.getString("expectedSha256"), before);
            preview += t("\n\n当前内容\n") + excerpt(decode(before)) + t("\n\n新内容\n") + excerpt(args.getString("content"));
        }
        if (operation.equals("mobile_create")) preview += "\n\n" + excerpt(args.getString("content"));
        if (operation.equals("mobile_create") || operation.equals("mobile_write")) {
            if (args.getString("content").getBytes(StandardCharsets.UTF_8).length > TEXT_LIMIT)
                throw new IOException(t("最多可保存 1 MiB 的文本。"));
        }
        if (operation.equals("mobile_delete")) {
            if (!n.directory() && n.size <= BACKUP_LIMIT) before = bytes(n, BACKUP_LIMIT);
            preview += n.directory() ? t("\n\n这将删除文件夹及其文件，不会为整个文件夹创建恢复副本。") :
                before != null ? t("\n\n删除前会在应用内部保留恢复副本。") : t("\n\n此大文件将直接删除，不会创建恢复副本。");
        }
        if (operation.equals("mobile_rename")) {
            String name = args.getString("name"); WorkspacePath.checkName(name);
            String parent = WorkspacePath.parent(path);
            String target = parent.isEmpty() ? name : parent + "/" + name;
            if (exists(target)) throw new IOException(t("已存在同名项目。"));
            preview += "\n→ " + target;
        }
        if (operation.equals("mobile_move")) {
            String destination = args.getString("destination"); WorkspacePath.segments(destination);
            if (destination.equals(path) || destination.startsWith(path + "/")) throw new IOException(t("不能将文件夹移动到自身内部。"));
            if (!resolve(destination).directory()) throw new IOException(t("目标位置不是文件夹。"));
            if ((n.flags & Document.FLAG_SUPPORTS_MOVE) == 0) throw new IOException(t("此存储提供方不支持移动文件。"));
            String target = destination.isEmpty() ? n.name : destination + "/" + n.name;
            if (exists(target)) throw new IOException(t("目标文件夹中已存在同名项目。"));
            preview += "\n→ " + target;
        }
        return new Mutation(operation, parse(args.toString()), tree.toString(), n == null ? "" : n.id,
            n == null ? 0 : n.modified, before, title, preview);
    }
    private String localScope() throws IOException { return "local:" + localRoot().getPath(); }
    private boolean localExists(String path) throws IOException { return local(path).exists(); }
    private void requireMutableLocalPath(String path) throws IOException {
        for (String segment : WorkspacePath.segments(path)) if (segment.equals(".git"))
            throw new IOException(t("不能使用文件工具修改 .git 内的文件。"));
    }
    /** Preflight recursive mutations so an ancestor cannot bypass .git or symlink protection. */
    private void requireSafeLocalTreeMutation(File root) throws IOException {
        ArrayDeque<File> pending = new ArrayDeque<>(); pending.add(root);
        int visited = 0;
        while (!pending.isEmpty()) {
            File value = pending.remove();
            if (++visited > 10_000) throw new IOException(t("一次最多修改 10,000 个项目。"));
            if (Files.isSymbolicLink(value.toPath()))
                throw new IOException(t("不能使用文件工具修改包含符号链接的文件夹。"));
            if (value.getName().equals(".git"))
                throw new IOException(t("不能使用文件工具修改 .git 内的文件。"));
            if (!value.isDirectory()) continue;
            File[] children = value.listFiles();
            if (children == null) throw new IOException(t("无法打开文件夹。"));
            pending.addAll(Arrays.asList(children));
        }
    }
    private Mutation prepareLocal(String operation, JSONObject args) throws Exception {
        requireWorkspaceAvailable();
        String path = args.getString("path"); requireMutableLocalPath(path);
        if (path.isEmpty()) throw new IOException(t("不能修改工作文件夹本身。"));
        File value = local(path); byte[] before = null; String title; String preview = path;
        if (operation.equals("mobile_create") || operation.equals("mobile_mkdir")) {
            if (value.exists()) throw new IOException(t("已存在同名文件或文件夹。"));
            if (!local(WorkspacePath.parent(path)).isDirectory()) throw new IOException(t("上级文件夹不存在。"));
            title = operation.equals("mobile_create") ? t("创建文件") : t("创建文件夹");
        } else {
            if (!value.exists()) throw new FileNotFoundException(t("找不到文件：") + path);
            title = switch (operation) {
                case "mobile_write" -> t("编辑文件");
                case "mobile_delete" -> t("删除文件");
                case "mobile_rename" -> t("重命名");
                case "mobile_move" -> t("移动文件");
                default -> throw new IOException(t("不支持的操作。"));
            };
        }
        if (operation.equals("mobile_write")) {
            before = localBytes(value, TEXT_LIMIT);
            WorkspacePath.requireVersion(args.getString("expectedSha256"), before);
            preview += t("\n\n当前内容\n") + excerpt(decode(before)) + t("\n\n新内容\n") + excerpt(args.getString("content"));
        }
        if (operation.equals("mobile_create")) preview += "\n\n" + excerpt(args.getString("content"));
        if (operation.equals("mobile_create") || operation.equals("mobile_write")) {
            if (args.getString("content").getBytes(StandardCharsets.UTF_8).length > TEXT_LIMIT)
                throw new IOException(t("最多可保存 1 MiB 的文本。"));
        }
        if (operation.equals("mobile_delete")) {
            requireSafeLocalTreeMutation(value);
            if (value.isFile() && value.length() <= BACKUP_LIMIT) before = localBytes(value, BACKUP_LIMIT);
            preview += value.isDirectory() ? t("\n\n这将删除文件夹及其文件，不会为整个文件夹创建恢复副本。") :
                before != null ? t("\n\n删除前会在应用内部保留恢复副本。") : t("\n\n此大文件将直接删除，不会创建恢复副本。");
        }
        if (operation.equals("mobile_rename")) {
            requireSafeLocalTreeMutation(value);
            String name = args.getString("name"); WorkspacePath.checkName(name);
            String parent = WorkspacePath.parent(path), target = parent.isEmpty() ? name : parent + "/" + name;
            requireMutableLocalPath(target);
            if (localExists(target)) throw new IOException(t("已存在同名项目。"));
            preview += "\n→ " + target;
        }
        if (operation.equals("mobile_move")) {
            requireSafeLocalTreeMutation(value);
            String destination = args.getString("destination"); WorkspacePath.segments(destination);
            requireMutableLocalPath(destination);
            if (destination.equals(path) || destination.startsWith(path + "/")) throw new IOException(t("不能将文件夹移动到自身内部。"));
            if (!local(destination).isDirectory()) throw new IOException(t("目标位置不是文件夹。"));
            String target = destination.isEmpty() ? value.getName() : destination + "/" + value.getName();
            if (localExists(target)) throw new IOException(t("目标文件夹中已存在同名项目。"));
            preview += "\n→ " + target;
        }
        return new Mutation(operation, parse(args.toString()), localScope(), value.getCanonicalPath(),
            value.exists() ? value.lastModified() : 0, before, title, preview);
    }
    private String excerpt(String s) { return s.length() <= 6000 ? s : s.substring(0, 6000) + t("\n…（预览已截断）"); }
    public synchronized JSONObject commit(Mutation m) throws Exception {
        if (m.tree.startsWith("local:")) return commitLocal(m);
        requireTree();
        if (!tree.toString().equals(m.tree)) throw new IOException(t("工作文件夹已变更，请求已取消。"));
        String path = m.args.getString("path");
        // Revalidate after the user has spent time reviewing the confirmation.
        Mutation now = prepare(m.operation, m.args);
        if (!now.documentId.equals(m.documentId) || now.modified != m.modified ||
            (m.before != null && !Arrays.equals(now.before, m.before)))
            throw new IOException(t("文件在审查期间发生了变化，请重试。"));
        Node parent = resolve(WorkspacePath.parent(path));
        String recoveryId = "";
        if (m.before != null) recoveryId = backup(m, resolve(path).mime);
        switch (m.operation) {
            case "mobile_create", "mobile_mkdir" -> {
                String mime = m.operation.equals("mobile_mkdir") ? Document.MIME_TYPE_DIR : "text/plain";
                Uri created = DocumentsContract.createDocument(context.getContentResolver(), parent.uri, mime, WorkspacePath.name(path));
                if (created == null) throw new IOException(t("无法创建项目。"));
                if (m.operation.equals("mobile_create")) write(created, m.args.getString("content").getBytes(StandardCharsets.UTF_8));
                path = WorkspacePath.parent(path).isEmpty() ? query(created).name : WorkspacePath.parent(path) + "/" + query(created).name;
            }
            case "mobile_write" -> write(resolve(path).uri, m.args.getString("content").getBytes(StandardCharsets.UTF_8));
            case "mobile_delete" -> {
                if (!DocumentsContract.deleteDocument(context.getContentResolver(), resolve(path).uri)) throw new IOException(t("无法删除项目。"));
            }
            case "mobile_rename" -> {
                Uri renamed = DocumentsContract.renameDocument(context.getContentResolver(), resolve(path).uri, m.args.getString("name"));
                if (renamed == null) throw new IOException(t("无法重命名项目。"));
                String name = query(renamed).name; WorkspacePath.checkName(name);
                String parentPath = WorkspacePath.parent(path);
                path = parentPath.isEmpty() ? name : parentPath + "/" + name;
            }
            case "mobile_move" -> {
                String destination = m.args.getString("destination");
                Uri moved = DocumentsContract.moveDocument(context.getContentResolver(), resolve(path).uri, parent.uri, resolve(destination).uri);
                if (moved == null) throw new IOException(t("无法移动项目。"));
                String name = query(moved).name; WorkspacePath.checkName(name);
                path = destination.isEmpty() ? name : destination + "/" + name;
            }
            default -> throw new IOException(t("不支持的操作。"));
        }
        if (!recoveryId.isEmpty()) {
            File metadata = new File(backups, recoveryId + ".json");
            JSONObject saved = parse(dev.mobilecodex.app.core.Utf8Files.read(metadata.toPath()));
            if (m.operation.equals("mobile_write")) saved.put("afterSha256", WorkspacePath.hash(bytes(resolve(path), TEXT_LIMIT)));
            else if (m.operation.equals("mobile_delete")) saved.put("afterMissing", true);
            saved.put("completed", true); dev.mobilecodex.app.core.Utf8Files.write(metadata.toPath(), saved.toString());
        }
        return obj("ok", true, "operation", m.operation, "path", path, "recoveryId", recoveryId);
    }
    private JSONObject commitLocal(Mutation m) throws Exception {
        requireWorkspaceAvailable();
        if (!localSelected() || !localScope().equals(m.tree)) throw new IOException(t("工作文件夹已变更，请求已取消。"));
        Mutation now = prepareLocal(m.operation, m.args);
        if (!now.documentId.equals(m.documentId) || now.modified != m.modified ||
                (m.before != null && !Arrays.equals(now.before, m.before)))
            throw new IOException(t("文件在审查期间发生了变化，请重试。"));
        String path = m.args.getString("path"); File value = local(path); String recoveryId = "";
        if (m.before != null) recoveryId = backup(m, value.exists() && value.isDirectory() ? Document.MIME_TYPE_DIR :
            Optional.ofNullable(Files.probeContentType(value.toPath())).orElse("application/octet-stream"));
        switch (m.operation) {
            case "mobile_create" -> {
                Files.createFile(value.toPath());
                Files.write(value.toPath(), m.args.getString("content").getBytes(StandardCharsets.UTF_8));
            }
            case "mobile_mkdir" -> Files.createDirectory(value.toPath());
            case "mobile_write" -> Files.write(value.toPath(), m.args.getString("content").getBytes(StandardCharsets.UTF_8));
            case "mobile_delete" -> deleteLocal(value);
            case "mobile_rename" -> {
                File target = local(WorkspacePath.parent(path).isEmpty() ? m.args.getString("name") :
                    WorkspacePath.parent(path) + "/" + m.args.getString("name"));
                Files.move(value.toPath(), target.toPath()); path = WorkspacePath.parent(path).isEmpty()
                    ? target.getName() : WorkspacePath.parent(path) + "/" + target.getName();
            }
            case "mobile_move" -> {
                String destination = m.args.getString("destination");
                File target = local(destination.isEmpty() ? value.getName() : destination + "/" + value.getName());
                Files.move(value.toPath(), target.toPath()); path = destination.isEmpty() ? target.getName() : destination + "/" + target.getName();
            }
            default -> throw new IOException(t("不支持的操作。"));
        }
        if ((m.operation.equals("mobile_create") || m.operation.equals("mobile_write")) &&
                !Arrays.equals(localBytes(local(path), TEXT_LIMIT), m.args.getString("content").getBytes(StandardCharsets.UTF_8)))
            throw new IOException(t("无法验证保存的内容，请检查恢复副本。"));
        if (!recoveryId.isEmpty()) {
            File metadata = new File(backups, recoveryId + ".json");
            JSONObject saved = parse(dev.mobilecodex.app.core.Utf8Files.read(metadata.toPath()));
            if (m.operation.equals("mobile_write")) saved.put("afterSha256", WorkspacePath.hash(localBytes(local(path), TEXT_LIMIT)));
            else if (m.operation.equals("mobile_delete")) saved.put("afterMissing", true);
            saved.put("completed", true); dev.mobilecodex.app.core.Utf8Files.write(metadata.toPath(), saved.toString());
        }
        return obj("ok", true, "operation", m.operation, "path", path, "recoveryId", recoveryId);
    }
    private void deleteLocal(File value) throws IOException {
        if (Files.isSymbolicLink(value.toPath())) throw new IOException(t("无法删除符号链接。"));
        if (value.isDirectory()) {
            File[] children = value.listFiles();
            if (children == null) throw new IOException(t("无法打开文件夹。"));
            for (File child : children) deleteLocal(child);
        }
        Files.delete(value.toPath());
    }
    private void write(Uri uri, byte[] data) throws IOException {
        try (OutputStream out = context.getContentResolver().openOutputStream(uri, "wt")) {
            if (out == null) throw new IOException(t("无法保存文件。"));
            out.write(data); out.flush();
        }
        if (!Arrays.equals(bytes(query(uri), TEXT_LIMIT), data)) throw new IOException(t("无法验证保存的内容，请检查恢复副本。"));
    }
    private String backup(Mutation m, String mime) throws Exception {
        String id = UUID.randomUUID().toString();
        if (backups.getUsableSpace() < m.before.length + 10 * 1024 * 1024L) throw new IOException(t("存储空间不足，无法保存恢复副本。"));
        Files.write(new File(backups, id + ".bin").toPath(), m.before);
        JSONObject meta = obj("id", id, "tree", m.tree, "workspace", workspace().optString("name", label), "path", m.args.getString("path"),
            "mime", mime, "operation", m.operation, "timestamp", System.currentTimeMillis(), "sha256", WorkspacePath.hash(m.before));
        Files.write(new File(backups, id + ".json").toPath(), meta.toString().getBytes(StandardCharsets.UTF_8));
        return id;
    }
    public synchronized JSONArray recoveryList() throws Exception {
        JSONArray out = new JSONArray();
        File[] files = backups.listFiles((d, n) -> n.endsWith(".json"));
        if (files == null) return out;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified).reversed());
        String scope = localSelected() ? localScope() : tree == null ? "" : tree.toString();
        for (File f : files) {
            JSONObject meta = parse(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
            if (!scope.isEmpty() && meta.optString("tree").equals(scope)) {
                meta.remove("tree"); out.put(meta);
            }
            if (out.length() >= 100) break;
        }
        return out;
    }
    private JSONObject recoveryMetadata(String id) throws Exception {
        requireWorkspaceAvailable();
        if (!id.matches("[a-f0-9-]{36}")) throw new IOException(t("无效的恢复项目。"));
        JSONObject meta = parse(dev.mobilecodex.app.core.Utf8Files.read(new File(backups, id + ".json").toPath()));
        String scope = localSelected() ? localScope() : tree == null ? "" : tree.toString();
        if (scope.isEmpty() || !scope.equals(meta.optString("tree"))) throw new IOException(t("此恢复项目属于其他项目。"));
        return meta;
    }
    public synchronized JSONObject previewRecovery(String id) throws Exception {
        JSONObject meta = recoveryMetadata(id); byte[] before = Files.readAllBytes(new File(backups, id + ".bin").toPath());
        WorkspacePath.requireVersion(meta.getString("sha256"), before);
        String path = meta.getString("path"), current = "", reason = "", currentHash = "";
        boolean localScope = meta.optString("tree").startsWith("local:");
        boolean present = localScope ? localExists(path) : exists(path), canRestore = meta.optBoolean("completed") && before.length <= TEXT_LIMIT;
        if (present) {
            byte[] after = localScope ? localBytes(local(path), TEXT_LIMIT) : bytes(resolve(path), TEXT_LIMIT);
            current = decode(after); currentHash = WorkspacePath.hash(after);
            if (!WorkspacePath.hash(after).equals(meta.optString("afterSha256"))) { canRestore = false; reason = t("文件后来发生了更改，请将副本保存到其他位置进行比较。"); }
        } else if (!meta.optBoolean("afterMissing")) { canRestore = false; reason = t("当前文件不存在，请将副本保存到其他位置。"); }
        if (!meta.optBoolean("completed")) reason = t("这是较早的副本，或完成状态未知。你可以将其另存到其他位置。");
        return obj("id", id, "path", path, "before", before.length <= TEXT_LIMIT ? decode(before) : t("[副本大于 1 MiB · 请另存查看]"), "after", current, "currentSha256", currentHash, "beforeExists", true, "afterExists", present,
            "canRestore", canRestore, "actionLabel", t("恢复此副本"), "note", reason.isEmpty() ? t("此副本在编辑或删除前创建。恢复前会再次检查当前文件。") : reason);
    }
    public synchronized JSONObject recoveryMutation(String id) throws Exception {
        JSONObject preview = previewRecovery(id);
        if (!preview.getBoolean("canRestore")) throw new IOException(preview.optString("note", t("无法自动恢复此副本。")));
        String path = preview.getString("path");
        if (preview.getBoolean("afterExists")) return obj("operation", "mobile_write", "arguments", obj("path", path, "content", preview.getString("before"), "expectedSha256", preview.getString("currentSha256")));
        return obj("operation", "mobile_create", "arguments", obj("path", path, "content", preview.getString("before")));
    }
    /** Exports a backup to a fresh user-picked destination; never overwrites the source. */
    public synchronized void exportRecovery(String id, Uri destination) throws Exception {
        if (!id.matches("[a-f0-9-]{36}")) throw new IOException(t("无效的恢复项目。"));
        byte[] data = Files.readAllBytes(new File(backups, id + ".bin").toPath());
        JSONObject meta = parse(dev.mobilecodex.app.core.Utf8Files.read(new File(backups, id + ".json").toPath()));
        WorkspacePath.requireVersion(meta.getString("sha256"), data);
        try (OutputStream out = context.getContentResolver().openOutputStream(destination, "wt")) {
            if (out == null) throw new IOException(t("无法导出恢复副本。"));
            out.write(data);
        }
    }
    public static final class Mutation {
        public final String operation, tree, documentId, title, preview;
        public final JSONObject args;
        public final long modified;
        public final byte[] before;
        Mutation(String operation, JSONObject args, String tree, String documentId, long modified, byte[] before, String title, String preview) {
            this.operation = operation; this.args = args; this.tree = tree; this.documentId = documentId;
            this.modified = modified; this.before = before; this.title = title; this.preview = preview;
        }
    }
    private static final class Node {
        final Uri uri;
        final String id, name, mime;
        final long size, modified;
        final int flags;
        Node(Uri uri, String id, String name, String mime, long size, long modified, int flags) {
            this.uri = uri; this.id = id; this.name = name; this.mime = mime; this.size = size; this.modified = modified; this.flags = flags;
        }
        boolean directory() { return Document.MIME_TYPE_DIR.equals(mime); }
        JSONObject json(String path) { return obj("name", name, "path", path, "directory", directory(), "mime", mime, "size", size, "modified", modified); }
    }
}
