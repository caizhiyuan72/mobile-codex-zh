package dev.mobilecodex.app.core;

import org.json.JSONObject;

/** Local, fixed explanations. Never persist upstream HTTP bodies or credentials. */
public final class ConversationFailure {
    private ConversationFailure() { }

    public static String code(JSONObject error) {
        return DiagnosticFailure.remoteCategory(error);
    }

    public static String message(String code) {
        return switch (code) {
            case "encrypted_transport_changed" -> "服务商拒绝恢复此对话（HTTP 409）：加密会话传输发生变化。长对话的自动压缩也可能因此失败。请联系服务商检查会话路由；原记录已保留，可先打开新对话。";
            case "upstream_conflict" -> "服务商返回会话冲突（HTTP 409）。请联系服务商检查会话状态；原记录已保留，可先打开新对话。";
            case "context_limit" -> "此对话的上下文已达到上限，本次请求未完成。可稍后重试，或打开新对话并补充任务进度；原记录已保留。";
            case "upstream_connection" -> "与服务商的连接在重试后仍未完成。请稍后重试；如果只有这条对话持续失败，可先打开新对话，原记录已保留。";
            case "usage_limit" -> "服务商的用量或速率限制使本次请求未完成。请检查额度或稍后重试。";
            case "upstream_auth" -> "服务商拒绝了身份验证，请在设置中检查 API 密钥。";
            case "upstream_bad_request" -> "服务商拒绝了本次请求，请检查模型和 API 配置。原对话记录已保留。";
            default -> "本次请求失败。请检查连接与服务商状态后重试，原对话记录已保留。";
        };
    }
}
