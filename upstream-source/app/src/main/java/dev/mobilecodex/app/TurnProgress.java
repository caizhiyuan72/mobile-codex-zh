package dev.mobilecodex.app;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.TreeMap;
import static dev.mobilecodex.app.core.Json.obj;

/** Only the public summary of the latest reasoning item is retained. */
final class TurnProgress {
    final String turn;
    private String itemId = "", phase = "waiting";
    private final TreeMap<Integer,String> parts = new TreeMap<>();
    private long lastEvent;

    TurnProgress(String turn, long now) { this.turn = turn; lastEvent = now; }

    boolean observe(String method, JSONObject p, long now) {
        if (!turn.equals(p.optString("turnId"))) return false;
        JSONObject item = p.optJSONObject("item");
        if (method.equals("item/reasoning/summaryTextDelta")) {
            String id = p.optString("itemId"); int i = p.optInt("summaryIndex", -1);
            if (id.isBlank() || i < 0 || i >= 16) return false;
            select(id); parts.put(i, bounded(parts.getOrDefault(i, ""), p.optString("delta")));
            phase = "reasoning";
        } else if (item != null && (method.equals("item/started") || method.equals("item/completed"))) {
            boolean end = method.equals("item/completed");
            String kind = item.optString("type");
            if (kind.equals("reasoning")) {
                select(item.optString("id")); JSONArray summary = item.optJSONArray("summary");
                if (summary != null && summary.length() > 0) {
                    parts.clear();
                    for (int i = 0; i < Math.min(16, summary.length()); i++)
                        if (summary.opt(i) instanceof String text) parts.put(i, bounded("", text));
                }
            }
            phase = end ? "waiting" : switch (kind) {
                case "reasoning" -> "reasoning";
                case "agentMessage" -> "responding";
                case "commandExecution" -> "command";
                case "fileChange" -> "editing";
                case "webSearch" -> "searching";
                default -> "tool";
            };
        } else if (method.equals("item/agentMessage/delta")) phase = "responding";
        else if (method.equals("item/commandExecution/outputDelta")) phase = "command";
        else if (method.equals("item/fileChange/outputDelta")) phase = "editing";
        else return false;
        lastEvent = now; return true;
    }

    private void select(String id) { if (!id.equals(itemId)) { itemId = id; parts.clear(); } }
    private static String bounded(String prefix, String delta) {
        int remaining = 2048 - prefix.length();
        if (delta.length() <= remaining) return prefix + delta;
        if (remaining <= 0) return prefix;
        return prefix + delta.substring(0, remaining - 1) + "…";
    }
    JSONObject snapshot(long engineReplyAt) {
        return obj("turnId", turn, "phase", phase, "lastEventAt", lastEvent, "engineReplyAt", engineReplyAt,
            "summary", String.join("\n\n", parts.values()).trim());
    }
}
