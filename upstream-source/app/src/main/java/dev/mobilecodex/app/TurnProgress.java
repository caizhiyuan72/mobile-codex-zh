package dev.mobilecodex.app;

import org.json.JSONObject;
import static dev.mobilecodex.app.core.Json.obj;

final class TurnProgress {
    final String turn;
    private String phase = "waiting";
    private long lastEvent;
    private long lastVisible;

    TurnProgress(String turn, long now) { this.turn = turn; lastEvent = now; lastVisible = now; }

    void visibleActivity(long now) { lastVisible = now; }

    boolean observe(String method, JSONObject p, long now) {
        if (!turn.equals(p.optString("turnId"))) return false;
        JSONObject item = p.optJSONObject("item");
        if (method.equals("item/reasoning/summaryTextDelta")) {
            if (p.optString("itemId").isBlank() || p.optInt("summaryIndex", -1) < 0) return false;
            phase = "reasoning";
        } else if (item != null && (method.equals("item/started") || method.equals("item/completed"))) {
            boolean end = method.equals("item/completed");
            String kind = item.optString("type");
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

    JSONObject snapshot(long engineReplyAt) {
        return obj("turnId", turn, "phase", phase, "lastEventAt", lastEvent, "lastVisibleAt", lastVisible, "engineReplyAt", engineReplyAt);
    }
}
