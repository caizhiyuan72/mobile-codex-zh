package dev.mobilecodex.app.core;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static dev.mobilecodex.app.core.Json.*;
import static org.junit.Assert.*;

public class WorkHistoryTest {
    @Test public void savedCommandKeepsItsPositionAndFinalResult() throws Exception {
        JSONObject command = obj("id", "cmd", "type", "commandExecution", "command", "pwd");
        JSONArray messages = array(obj("id", "intro", "role", "assistant"));
        WorkHistory.record(messages, command, "turn", false, messages.length());
        WorkHistory.append(messages, "turn", "cmd", "partial");
        messages.put(obj("id", "reply", "role", "assistant"));
        WorkHistory.record(messages, command.put("aggregatedOutput", "result").put("exitCode", 3), "turn", true, messages.length());
        WorkHistory.append(messages, "turn", "cmd", "late output");
        JSONArray saved = new JSONArray(messages.toString());
        assertEquals(3, saved.length());
        JSONObject row = saved.getJSONObject(1);
        assertEquals("pwd", row.getString("detail"));
        assertEquals("result", row.getString("output"));
        assertTrue(row.getBoolean("failed"));
        assertTrue(row.getBoolean("completed"));
    }

    @Test public void oldHistoryRestoresToolRowsAfterTheirCommentaryWithoutDuplicates() throws Exception {
        JSONObject user = obj("id", "local-user", "role", "user");
        JSONObject intro = obj("id", "intro", "role", "assistant");
        JSONObject reply = obj("id", "reply", "role", "assistant");
        JSONArray messages = array(user, intro, reply);
        JSONArray turns = array(obj("id", "turn", "items", array(obj("id", "remote-user", "type", "userMessage"),
            obj("id", "intro", "type", "agentMessage"), obj("id", "cmd", "type", "commandExecution", "command", "pwd"),
            obj("id", "reply", "type", "agentMessage"))));
        WorkHistory.restore(messages, turns);
        WorkHistory.restore(messages, turns);
        assertEquals(4, messages.length());
        assertEquals("intro", messages.getJSONObject(1).getString("id"));
        assertEquals("pwd", messages.getJSONObject(2).getString("detail"));
        assertEquals("reply", messages.getJSONObject(3).getString("id"));
    }

    @Test public void searchCompletionUpdatesTheSavedRowWithoutDuplicatingIt() throws Exception {
        JSONArray messages = array();
        JSONObject search = obj("id", "search", "type", "webSearch", "query", "Codex models");
        assertTrue(WorkHistory.record(messages, search, "turn", false, 0));
        assertFalse(messages.getJSONObject(0).getBoolean("completed"));
        assertTrue(WorkHistory.record(messages, search.put("query", "Codex app models"), "turn", true, 1));
        assertFalse(WorkHistory.record(messages, search, "turn", false, 1));
        assertEquals(1, messages.length());
        JSONObject row = messages.getJSONObject(0);
        assertEquals("searching", row.getString("activityKind"));
        assertEquals("Codex app models", row.getString("detail"));
        assertTrue(row.getBoolean("completed"));
    }

    @Test public void dynamicSearchKeepsItsPositionAndQueryWhenCompletionOmitsArguments() throws Exception {
        JSONArray messages = array(obj("id", "intro", "role", "assistant"));
        JSONObject search = obj("id", "search", "type", "dynamicToolCall", "tool", "mobile_search",
            "arguments", obj("query", "README", "unrelated", "hidden"));
        assertTrue(WorkHistory.record(messages, search, "turn", false, messages.length()));
        messages.put(obj("id", "reply", "role", "assistant"));
        search.remove("arguments");
        search.put("contentItems", array(obj("type", "inputImage", "imageUrl", "hidden"), obj("type", "inputText", "text", "README.md")));
        assertTrue(WorkHistory.record(messages, search, "turn", true, messages.length()));
        assertEquals(3, messages.length());
        JSONObject row = messages.getJSONObject(1);
        assertEquals("searching", row.getString("activityKind"));
        assertEquals("mobile_search · README", row.getString("detail"));
        assertEquals("README.md", row.getString("output"));
        assertTrue(row.getBoolean("completed"));
        assertFalse(row.toString().contains("hidden"));
        assertEquals("reply", messages.getJSONObject(2).getString("id"));
    }
}
