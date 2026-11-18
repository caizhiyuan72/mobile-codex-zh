package dev.mobilecodex.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.file.Files;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static dev.mobilecodex.app.core.Json.obj;

/** Small, per-turn journal of app-server tool evidence; no model prose or raw tool output. */
final class TaskSummary {
    private static final int LIMIT = 40;
    private static final Set<String> TOOLS = Set.of("commandExecution", "fileChange", "dynamicToolCall", "mcpToolCall", "webSearch", "imageGeneration", "imageView", "collabAgentToolCall");
    private static final String TOKEN = "(?:'[^'\\r\\n]+'|\"[^\"\\r\\n$`\\\\]+\"|[a-zA-Z0-9_./-]+)";
    private static final String TAG = "(?:'[a-zA-Z0-9_]+'|\"[a-zA-Z0-9_]+\"|[a-zA-Z0-9_]+)";
    // Only a literal destination of an explicit here-doc write is inferred from shell commands.
    private static final Pattern WRITE = Pattern.compile("^(?:/system/bin/|/usr/bin/)?cat[ \\t]+(?:>[ \\t]*(" + TOKEN + ")[ \\t]+<<-?[ \\t]*(" + TAG + ")|<<-?[ \\t]*(" + TAG + ")[ \\t]+>[ \\t]*(" + TOKEN + "))[ \\t]*\\r?\\n");
    private static final Pattern SHELL = Pattern.compile("^(?:(?:/system/bin/|/bin/|/usr/bin/)?(?:sh|bash|dash|zsh)) +-(?:l?c|cl) +");
    private static final Pattern CHECK = Pattern.compile("^(git diff --check|npm test|npm run (?:test|lint|check)|node --test|(?:python3?|python3?\\.[0-9]+) -m (?:pytest|unittest)|pytest|(?:\\./)?gradlew (?:[a-zA-Z0-9_:]*:)?(?:test[a-zA-Z0-9]*|lint[a-zA-Z0-9]*|check))(?:(?: +--)? +[a-zA-Z0-9_./:=,-]+)*$");

    private record Change(String action, String path, File file, boolean verified) {}
    private record Tool(String type, boolean finished, boolean failed, String check, Integer exitCode, Set<Change> changes) {}
    private final Map<String, Tool> items = new LinkedHashMap<>();
    private final Set<Change> nativeChanges = new LinkedHashSet<>();
    private final long turnStartedAt;
    private int omitted;

    TaskSummary(long turnStartedAt) { this.turnStartedAt = turnStartedAt; }

    boolean isEmpty() { return items.isEmpty() && nativeChanges.isEmpty(); }

    void item(JSONObject item, boolean completion, File projectDirectory) {
        String id = item.optString("id"), type = item.optString("type");
        if (id.isBlank() || !TOOLS.contains(type)) return;
        String status = item.optString("status");
        boolean finished = completion && !"inProgress".equals(status);
        Tool previous = items.get(id);
        if (previous != null && (previous.finished || !previous.type.equals(type))) return;
        if (previous == null && items.size() == LIMIT) { omitted++; return; }
        Integer exit = item.opt("exitCode") instanceof Number value ? value.intValue() : null;
        boolean failed = "failed".equals(status) || "declined".equals(status) || "interrupted".equals(status)
            || Boolean.FALSE.equals(item.opt("success")) || exit != null && exit != 0;
        String check = "";
        Set<Change> changes = new LinkedHashSet<>();
        if (finished && type.equals("fileChange") && status.equals("completed")) {
            JSONArray entries = item.optJSONArray("changes");
            for (int i = 0; entries != null && i < entries.length() && changes.size() < LIMIT; i++) {
                JSONObject change = entries.optJSONObject(i);
                if (change == null) continue;
                JSONObject kind = change.optJSONObject("kind");
                if (kind == null) continue;
                String action = kind.optString("type"), path = path(change.optString("path"));
                if (path.isEmpty() || !Set.of("add", "update", "delete").contains(action)) continue;
                if (action.equals("update") && !kind.isNull("move_path")) {
                    path = path(kind.optString("move_path"));
                    action = "move";
                }
                if (!path.isEmpty()) changes.add(new Change(action, path, resolve(projectDirectory, path), false));
            }
        } else if (finished && type.equals("commandExecution")) {
            String command = shellBody(item.optString("command"));
            Matcher checked = CHECK.matcher(command);
            if (command.length() <= 256 && checked.matches()) check = checked.group(1);
            if (!failed && status.equals("completed") && exit != null && exit == 0) {
                String destination = writeDestination(command);
                String cwd = path(item.optString("cwd"));
                File file = resolve(cwd.isEmpty() ? projectDirectory : resolve(projectDirectory, cwd), destination);
                if (regular(file) && file.lastModified() >= turnStartedAt)
                    changes.add(new Change("write", file.getAbsolutePath(), file, false));
            }
        }
        items.put(id, new Tool(type, finished, failed, check, exit, changes));
    }

    void committed(JSONObject result, String workspaceName, File directory) {
        String action = switch (result.optString("operation")) {
            case "mobile_create", "mobile_mkdir" -> "add";
            case "mobile_write" -> "update";
            case "mobile_delete" -> "delete";
            case "mobile_rename", "mobile_move" -> "move";
            default -> "";
        };
        String relative = path(result.optString("path"));
        if (nativeChanges.size() >= LIMIT || !result.optBoolean("ok") || action.isEmpty() || relative.isEmpty()) return;
        File file = resolve(directory, relative);
        String display = file != null ? file.getAbsolutePath() : (workspaceName.isBlank() ? relative : workspaceName + " / " + relative);
        nativeChanges.add(new Change(action, display, file, file == null));
    }

    JSONObject message(String turnId, String status, boolean hasFinalReply) {
        if (isEmpty()) return null;
        Set<String> locations = new LinkedHashSet<>();
        JSONArray changes = new JSONArray(), checks = new JSONArray();
        Set<Change> allChanges = new LinkedHashSet<>(nativeChanges);
        int unfinished = 0, failed = 0;
        for (Tool tool : items.values()) {
            allChanges.addAll(tool.changes);
            if (!tool.finished) unfinished++;
            else if (tool.failed) failed++;
            if (!tool.check.isEmpty() && tool.exitCode != null)
                checks.put(obj("command", tool.check, "exitCode", tool.exitCode));
        }
        for (Change change : allChanges) {
            if (changes.length() == LIMIT) break;
            changes.put(obj("action", change.action, "path", change.path));
            if (change.action.equals("delete")) locations.remove(change.path);
            else if (change.verified || exists(change.file)) locations.add(change.path);
        }
        return obj("id", "task-summary-" + turnId, "role", "assistant", "kind", "taskSummary", "summary", obj(
            "status", status, "missingReply", "completed".equals(status) && !hasFinalReply,
            "changes", changes, "locations", new JSONArray(locations), "checks", checks,
            "failed", failed, "unfinished", unfinished, "limited", omitted > 0));
    }

    private static String shellBody(String command) {
        if (command.length() > 131072) return "";
        Matcher prefix = SHELL.matcher(command);
        if (!prefix.find()) return command;
        String quoted = command.substring(prefix.end());
        if (!quoted.startsWith("'") || !quoted.endsWith("'")) return "";
        String inner = quoted.substring(1, quoted.length() - 1);
        String withoutEscapes = inner.replace("'\\''", "");
        return withoutEscapes.indexOf('\'') == -1 ? inner.replace("'\\''", "'") : "";
    }

    private static String writeDestination(String command) {
        Matcher write = WRITE.matcher(command);
        if (!write.find()) return "";
        String destination = unquote(write.group(1) != null ? write.group(1) : write.group(4));
        if (destination.indexOf('$') >= 0 || destination.indexOf('`') >= 0) return "";
        String delimiter = unquote(write.group(2) != null ? write.group(2) : write.group(3));
        // The closing delimiter must be the last line; no later command can replace or delete the output.
        String body = command.substring(write.end());
        Pattern end = Pattern.compile("(?m)^\\t*" + Pattern.quote(delimiter) + "\\r?$");
        Matcher boundary = end.matcher(body);
        return boundary.find() && body.substring(boundary.end()).isBlank() ? path(destination) : "";
    }

    private static String unquote(String token) {
        return token.startsWith("'") || token.startsWith("\"") ? token.substring(1, token.length() - 1) : token;
    }

    private static String path(String value) {
        return value.length() <= 1024 && !value.isBlank() && value.codePoints().noneMatch(Character::isISOControl) ? value : "";
    }

    private static File resolve(File directory, String path) {
        if (path.isEmpty()) return null;
        File file = new File(path);
        if (!file.isAbsolute() && directory == null) return null;
        return (file.isAbsolute() ? file : new File(directory, path)).toPath().normalize().toFile();
    }

    private static boolean regular(File file) {
        try { return file != null && Files.isRegularFile(file.toPath()); }
        catch (SecurityException ignored) { return false; }
    }

    private static boolean exists(File file) {
        try { return file != null && Files.exists(file.toPath()); }
        catch (SecurityException ignored) { return false; }
    }
}
