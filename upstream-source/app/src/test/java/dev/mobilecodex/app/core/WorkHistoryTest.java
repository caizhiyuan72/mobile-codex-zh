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
}
