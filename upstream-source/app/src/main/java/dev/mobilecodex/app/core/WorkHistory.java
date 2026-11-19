package dev.mobilecodex.app.core;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import static dev.mobilecodex.app.core.Json.obj;

public final class WorkHistory {
    private static final int OUTPUT_LIMIT = 4000;
    private WorkHistory() {}

    public static boolean record(JSONArray messages, JSONObject item, String turn, boolean completed, int position) throws JSONException {
        if (messages == null || item == null || turn.isBlank() || item.optString("id").isBlank()) return false;
        String kind = item.optString("type");
        String detail, output;
        if ("commandExecution".equals(kind)) {
            detail = item.optString("command");
            output = item.optString("aggregatedOutput", "");
        } else if ("fileChange".equals(kind)) {
            StringBuilder paths = new StringBuilder(), diff = new StringBuilder();
            JSONArray changes = item.optJSONArray("changes");
            for (int index = 0; changes != null && index < changes.length() && paths.length() < OUTPUT_LIMIT; index++) {
                JSONObject change = changes.optJSONObject(index);
                if (change == null) continue;
                if (paths.length() > 0) paths.append(", ");
                paths.append(head(change.optString("path")));
                if (diff.length() < OUTPUT_LIMIT) diff.append(head(change.optString("diff"))).append('\n');
            }
            detail = paths.toString(); output = diff.toString().trim();
        } else return false;
        String id = id(turn, item.optString("id"));
        String status = item.optString("status");
        boolean interrupted = "declined".equals(status) || "interrupted".equals(status);
        boolean failed = "failed".equals(status) || item.optInt("exitCode", 0) != 0;
        int existing = indexOf(messages, id);
        JSONObject row;
        if (existing >= 0) {
            row = messages.getJSONObject(existing);
            if (row.optBoolean("completed") && !completed) return false;
        } else {
            row = obj("id", id, "kind", "toolActivity", "role", "tool", "text", "", "activityTurnId", turn);
            int insert = Math.min(position, messages.length());
            for (int index = messages.length(); index > insert; index--) messages.put(index, messages.get(index - 1));
            messages.put(insert, row);
        }
        row.put("activityKind", "fileChange".equals(kind) ? "editing" : "command")
            .put("completed", completed).put("failed", failed).put("interrupted", interrupted);
        if (!detail.isBlank()) row.put("detail", head(detail));
        if (!output.isBlank()) row.put("output", tail(output));
        return true;
    }

    public static void finish(JSONArray messages, String turn) throws JSONException {
        for (int index = 0; messages != null && index < messages.length(); index++) {
            JSONObject row = messages.optJSONObject(index);
            if (row != null && "toolActivity".equals(row.optString("kind")) && turn.equals(row.optString("activityTurnId")) && !row.optBoolean("completed"))
                row.put("completed", true).put("interrupted", true);
        }
    }

    public static void append(JSONArray messages, String turn, String item, String delta) throws JSONException {
        int index = indexOf(messages, id(turn, item));
        if (index < 0) return;
        JSONObject row = messages.getJSONObject(index);
        if (!row.optBoolean("completed")) row.put("output", tail(row.optString("output") + tail(delta)));
    }

    public static void restore(JSONArray messages, JSONArray turns) throws JSONException {
        int cursor = 0;
        for (int turnIndex = 0; turnIndex < turns.length(); turnIndex++) {
            JSONObject turn = turns.optJSONObject(turnIndex);
            if (turn == null) continue;
            String turnId = turn.optString("id");
            JSONArray items = turn.optJSONArray("items");
            for (int itemIndex = 0; items != null && itemIndex < items.length(); itemIndex++) {
                JSONObject item = items.optJSONObject(itemIndex);
                if (item == null) continue;
                if ("userMessage".equals(item.optString("type"))) {
                    while (cursor < messages.length() && !"user".equals(messages.getJSONObject(cursor++).optString("role"))) { }
                    break;
                }
            }
            for (int itemIndex = 0; items != null && itemIndex < items.length(); itemIndex++) {
                JSONObject item = items.optJSONObject(itemIndex);
                if (item == null) continue;
                if ("agentMessage".equals(item.optString("type"))) {
                    int anchor = indexOf(messages, item.optString("id"));
                    if (anchor >= cursor) cursor = anchor + 1;
                } else if (cursor > 0) {
                    int existing = indexOf(messages, id(turnId, item.optString("id")));
                    if (record(messages, item, turnId, true, cursor)) cursor = existing >= 0 ? Math.max(cursor, existing + 1) : cursor + 1;
                }
            }
        }
    }

    private static String id(String turn, String item) { return "work:" + turn + ":" + item; }
    private static int indexOf(JSONArray messages, String id) {
        for (int index = messages == null ? -1 : messages.length() - 1; index >= 0; index--) {
            JSONObject candidate = messages.optJSONObject(index);
            if (candidate != null && id.equals(candidate.optString("id"))) return index;
        }
        return -1;
    }
    private static String head(String value) { return value.substring(0, Math.min(OUTPUT_LIMIT, value.length())); }
    private static String tail(String value) { return value.length() > OUTPUT_LIMIT ? "…\n" + value.substring(value.length() - OUTPUT_LIMIT + 2) : value; }
}
