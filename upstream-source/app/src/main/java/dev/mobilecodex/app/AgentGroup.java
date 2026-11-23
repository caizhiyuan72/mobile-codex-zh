package dev.mobilecodex.app;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.*;
import java.util.regex.*;
import static dev.mobilecodex.app.core.Json.*;

/**
 * Pure rules for a Codex chat that other agents were invited into. The chat's
 * own message list is the shared history; each agent keeps a cursor into it.
 */
final class AgentGroup {
    private AgentGroup() {}
    static final String CODEX = "codex";
    /** Invitable agents: member id, provider id, display name. */
    static final List<String[]> AGENTS = List.of(new String[]{"claude", "claude", "Claude"}, new String[]{"gemini", "agy", "Gemini"});
    static final Set<String> MODES = Set.of("chat", "read", "write");
    static final int MAX_CONTEXT = 160000;
    private static final Map<String, List<String>> ALIASES = Map.of(
        CODEX, List.of("codex"),
        "claude", List.of("claude"),
        "gemini", List.of("gemini", "agy", "antigravity"));
    private static final List<String> EVERYONE = List.of("all", "everyone", "所有人", "全体");
    private static final Pattern MENTION = Pattern.compile("@([\\p{L}\\p{N}_-]+)");
    private static final Pattern CALLER = Pattern.compile("[\\p{L}\\p{N}_@-]");
    private static final Pattern NOT_A_CALL = Pattern.compile("^(?:/|:[^\\s]|\\.[\\p{L}\\p{N}_-])");

    static String[] agent(String id) {
        for (String[] value : AGENTS) if (value[0].equals(id)) return value;
        return null;
    }
    static String name(String id) { if (CODEX.equals(id)) return "Codex"; String[] value = agent(id); return value == null ? id : value[2]; }

    /** Enabled agents in invitation order. */
    static List<JSONObject> enabled(JSONObject session) {
        List<JSONObject> out = new ArrayList<>();
        JSONArray agents = session == null ? null : session.optJSONArray("agents");
        if (agents != null) for (int i = 0; i < agents.length(); i++) {
            JSONObject agent = agents.optJSONObject(i);
            if (agent != null && agent.optBoolean("enabled", true) && agent(agent.optString("id")) != null) out.add(agent);
        }
        return out;
    }
    static boolean grouped(JSONObject session) { return !enabled(session).isEmpty(); }
    static JSONObject member(JSONObject session, String id) {
        for (JSONObject agent : enabled(session)) if (agent.optString("id").equals(id)) return agent;
        return null;
    }
    /** Participants are Codex first, then invited agents. */
    static List<String> participants(JSONObject session) {
        List<String> ids = new ArrayList<>(); ids.add(CODEX);
        for (JSONObject agent : enabled(session)) ids.add(agent.optString("id"));
        return ids;
    }

    // Adapted from CodePet (MIT), see assets/rooms/CODEPET-LICENSE: fenced and inline
    // code, e-mail addresses, @file:/@app: tokens and paths never call a participant.
    static String mask(String text) {
        StringBuilder out = new StringBuilder(text == null ? "" : text);
        Matcher fenced = Pattern.compile("```[\\s\\S]*?(?:```|$)").matcher(out);
        while (fenced.find()) for (int i = fenced.start(); i < fenced.end(); i++) out.setCharAt(i, ' ');
        Matcher inline = Pattern.compile("`[^`\\r\\n]*`").matcher(out);
        while (inline.find()) for (int i = inline.start(); i < inline.end(); i++) out.setCharAt(i, ' ');
        return out.toString();
    }
    private static boolean matches(String token, String alias) {
        if (!token.toLowerCase(Locale.ROOT).startsWith(alias.toLowerCase(Locale.ROOT))) return false;
        String rest = token.substring(alias.length());
        // A non-ASCII suffix can follow the alias; "@claudette" is a different name.
        return rest.isEmpty() || !rest.matches("^[A-Za-z0-9_-].*");
    }
    /** Participant ids called in text, in the order they were first mentioned. */
    static List<String> mentions(String text, List<String> participants) {
        String source = mask(text);
        LinkedHashSet<String> found = new LinkedHashSet<>();
        Matcher matcher = MENTION.matcher(source);
        while (matcher.find()) {
            if (matcher.start() > 0 && CALLER.matcher(String.valueOf(source.charAt(matcher.start() - 1))).matches()) continue;
            if (NOT_A_CALL.matcher(source.substring(matcher.end())).find()) continue;
            String token = matcher.group(1);
            if (EVERYONE.stream().anyMatch(alias -> matches(token, alias))) { found.addAll(participants); continue; }
            for (String id : participants)
                if (ALIASES.getOrDefault(id, List.of(id)).stream().anyMatch(alias -> matches(token, alias))) { found.add(id); break; }
        }
        return new ArrayList<>(found);
    }
    /** Without a mention everyone answers; this orders dispatch, not the responses. */
    static List<String> targets(String text, JSONObject session) {
        List<String> participants = participants(session), called = mentions(text, participants);
        List<String> ids = called.isEmpty() ? participants : called;
        List<String> ordered = new ArrayList<>();
        if (ids.contains(CODEX)) ordered.add(CODEX);
        for (String id : ids) if (!id.equals(CODEX)) ordered.add(id);
        return ordered;
    }

    static String speaker(JSONObject message) {
        if ("user".equals(message.optString("role"))) return "用户";
        String agent = message.optString("agent");
        return agent.isBlank() ? "@codex (Codex)" : "@" + agent + " (" + message.optString("agentName", name(agent)) + ")";
    }
    private static boolean shareable(JSONObject message) {
        if (message == null) return false;
        String role = message.optString("role");
        if (!role.equals("user") && !role.equals("assistant")) return false;
        if (!message.optString("agent").isBlank() && !"complete".equals(message.optString("status"))) return false;
        return !message.optString("text").isBlank() || message.optJSONArray("attachments") != null;
    }
    private static String line(JSONObject message) {
        String text = message.optString("text").trim();
        JSONArray files = message.optJSONArray("attachments");
        if (files != null && files.length() > 0) text += (text.isEmpty() ? "" : "\n") + "（" + files.length() + " 个附件，仅 Codex 可查看）";
        return "[" + speaker(message) + "] " + text;
    }
    static int indexOf(JSONArray messages, String id) {
        if (id == null || id.isBlank()) return -1;
        for (int i = messages.length() - 1; i >= 0; i--) { JSONObject m = messages.optJSONObject(i); if (m != null && id.equals(m.optString("id"))) return i; }
        return -1;
    }
    /** Messages after the cursor, newest kept when the whole backlog does not fit. */
    static String transcript(JSONArray messages, int from, int to, Set<String> skip, int budget) {
        ArrayDeque<String> lines = new ArrayDeque<>(); int size = 0, omitted = 0;
        for (int i = Math.min(to, messages.length()) - 1; i >= Math.max(0, from); i--) {
            JSONObject message = messages.optJSONObject(i);
            if (!shareable(message) || skip.contains(message.optString("id"))) continue;
            String value = line(message);
            if (size + value.length() + 2 > budget) { omitted++; continue; }
            lines.addFirst(value); size += value.length() + 2;
        }
        String body = String.join("\n\n", lines);
        return omitted == 0 ? body : "（受长度限制，省略了前面 " + omitted + " 条消息。）\n\n" + body;
    }
    private static String roster(JSONObject session, String self) {
        List<String> names = new ArrayList<>();
        for (String id : participants(session)) if (!id.equals(self)) names.add("@" + id + " (" + name(id) + ")");
        return String.join(", ", names);
    }
    /** Context placed before the user's own input when Codex takes its turn. */
    static String codexContext(JSONObject session, JSONArray messages, int upTo, Set<String> skip) {
        int from = indexOf(messages, session.optString("codexCursorId")) + 1;
        Set<String> known = new HashSet<>(skip);
        if (!session.optString("codexCursorId").isBlank()) for (int i = from; i < upTo; i++) {
            JSONObject m = messages.optJSONObject(i);
            if (m != null && "assistant".equals(m.optString("role")) && m.optString("agent").isBlank()) known.add(m.optString("id"));
        }
        String body = transcript(messages, from, upTo, known, MAX_CONTEXT);
        StringBuilder out = new StringBuilder("[群组对话] 除用户和 Codex 外，当前参与者还有 ").append(roster(session, CODEX))
            .append("。仅在确实需要其他参与者的意见时，用独立的 @ID 提及对方。");
        if (!body.isBlank()) out.append("\n\nCodex 上次回复后的消息：\n").append(body);
        return out.append("\n[群组对话结束]").toString();
    }
    /** Prompt for an invited agent: everything after its cursor, plus who is present. */
    static String agentPrompt(JSONObject session, JSONObject member, JSONArray messages) {
        String id = member.optString("id");
        int from = indexOf(messages, member.optString("cursorId")) + 1;
        String mode = member.optString("mode", "chat");
        String access = switch (mode) {
            case "read" -> "只能使用 mobile_* 工具读取或搜索工作目录。修改须交由 Codex 执行。";
            case "write" -> "可以使用 mobile_* 工具处理工作目录。修改和命令必须遵守应用审批设置和任务轮次。";
            default -> "不能使用文件或手机工具，只能通过对话回复。";
        };
        String header = "你是 Mobile Codex 群组对话中的 @" + id + " (" + name(id) + ")。其他参与者：" + roster(session, id) + "。\n"
            + access + " 阅读共享对话记录后回复。同一问题可能有其他参与者同时作答。仅在确实需要其他参与者的意见时，用独立的 @ID 提及对方。"
            + " @file:路径 和 @app:名称 不是对参与者的提及。没有工具结果，不要声称操作已成功。\n\n";
        Set<String> known = new HashSet<>();
        if (!member.optString("nativeSession").isBlank()) for (int i = from; i < messages.length(); i++) {
            JSONObject m = messages.optJSONObject(i);
            if (m != null && id.equals(m.optString("agent"))) known.add(m.optString("id"));
        }
        String body = transcript(messages, from, messages.length(), known, MAX_CONTEXT - header.length());
        return header + "\n新对话记录：\n" + body + "\n\n现在请回复。";
    }
    /** The agent ids an AI reply asks to hear from next. */
    static List<String> followUps(String text, JSONObject session, String self) {
        List<String> out = new ArrayList<>();
        for (String id : mentions(text, participants(session))) if (!id.equals(self)) out.add(id);
        return out;
    }
    static JSONObject newAgent(String id, String model, String effort, String mode) throws Exception {
        String[] value = agent(id);
        if (value == null) throw new IllegalArgumentException("Unknown agent");
        if (!MODES.contains(mode)) throw new IllegalArgumentException("Invalid agent permission");
        return obj("id", value[0], "provider", value[1], "name", value[2], "model", model, "effort", effort, "mode", mode,
            "approvalMode", "ask", "character", "", "enabled", true, "nativeSession", "", "cursorId", "");
    }
}
