package dev.mobilecodex.app;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.HashMap;
import java.util.Map;
import static dev.mobilecodex.app.core.Json.obj;

final class TurnAgents {
    final String turn;
    private final Map<String, Boolean> active = new HashMap<>();

    TurnAgents(String turn) { this.turn = turn; }
    boolean contains(String id) { return active.containsKey(id); }
    boolean setActive(String id, boolean running) {
        return contains(id) && active.put(id, running) != running;
    }
    boolean spawned(String id) {
        return !id.isBlank() && active.putIfAbsent(id, true) == null;
    }
    boolean item(JSONObject item, String root, String sender) {
        if (item == null || !"collabAgentToolCall".equals(item.optString("type"))
                || !sender.equals(item.optString("senderThreadId"))) return false;
        boolean changed = false;
        if ("spawnAgent".equals(item.optString("tool")) && "completed".equals(item.optString("status"))) {
            JSONArray ids = item.optJSONArray("receiverThreadIds");
            for (int index = 0; ids != null && index < ids.length(); index++) {
                Object value = ids.opt(index);
                if (value instanceof String id && !id.equals(root) && !id.equals(sender)) changed |= spawned(id);
            }
        }
        JSONObject states = item.optJSONObject("agentsStates");
        if (states != null) for (var keys = states.keys(); keys.hasNext();) {
            String id = keys.next(); JSONObject state = states.optJSONObject(id);
            if (state == null) continue;
            switch (state.optString("status")) {
                case "pendingInit", "running" -> changed |= setActive(id, true);
                case "completed", "errored", "interrupted", "shutdown", "notFound" -> changed |= setActive(id, false);
            }
        }
        return changed;
    }
    int total() { return active.size(); }
    JSONObject snapshot() {
        int running = 0;
        for (boolean value : active.values()) if (value) running++;
        return obj("turnId", turn, "total", total(), "running", running);
    }
}
