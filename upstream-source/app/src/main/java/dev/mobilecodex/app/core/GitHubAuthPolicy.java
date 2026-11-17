package dev.mobilecodex.app.core;

import org.json.JSONObject;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** Fixed GitHub OAuth boundaries; no client ID or secret is supplied by the application. */
public final class GitHubAuthPolicy {
    public static final String DEVICE_URL = "https://github.com/login/device/code";
    public static final String TOKEN_URL = "https://github.com/login/oauth/access_token";
    public static final String USER_URL = "https://api.github.com/user";
    public static final String VERIFICATION_URI = "https://github.com/login/device";
    public static final String REQUESTED_SCOPE = "public_repo workflow";
    public static final List<String> REQUESTED_SCOPES = List.of("public_repo", "workflow");
    public static final long MIN_POLL_MILLIS = 5000;
    public static final int MAX_RESPONSE_BYTES = 64 * 1024;
    private GitHubAuthPolicy() {}

    /** A Client ID is public. The empty value means this installation is not configured. */
    public static String clientId(String input) throws IOException {
        String value = input == null ? "" : input.trim();
        if (!value.isEmpty() && !value.matches("[A-Za-z0-9][A-Za-z0-9._-]{7,127}"))
            throw new IOException("请填写自己注册的 GitHub OAuth App 的公开 Client ID。");
        return value;
    }

    public static String deviceCode(String value) throws IOException {
        return secret(value, 2048, "GitHub 返回的设备授权数据无效，请重新授权。");
    }

    public static String accessToken(String value) throws IOException {
        return secret(value, 4096, "GitHub 返回的授权凭据无效，请重新授权。");
    }

    private static String secret(String value, int maximum, String error) throws IOException {
        if (value == null || value.isEmpty() || value.length() > maximum
                || value.chars().anyMatch(c -> c < 33 || c > 126))
            throw new IOException(error);
        return value;
    }

    public static String userCode(String value) throws IOException {
        if (value == null || !value.matches("[A-Za-z0-9-]{4,32}"))
            throw new IOException("GitHub 返回的设备验证码无效，请重新授权。");
        return value;
    }

    public static String verificationUri(String value) throws IOException {
        if (!VERIFICATION_URI.equals(value) && !(VERIFICATION_URI + "/").equals(value))
            throw new IOException("GitHub 返回的授权网址无效，请重新授权。");
        return VERIFICATION_URI;
    }

    public static String login(String value) throws IOException {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9-]{0,38}"))
            throw new IOException("无法验证 GitHub 账号，请重新授权。");
        return value;
    }

    public static List<String> scopes(String raw) throws IOException {
        if (raw == null || raw.length() > 4096) throw scopeError();
        Set<String> scopes = new LinkedHashSet<>();
        for (String item : raw.trim().split("[,\\s]+")) {
            if (item.isEmpty()) continue;
            if (!item.matches("[A-Za-z0-9_:.-]{1,64}") || scopes.size() >= 100) throw scopeError();
            scopes.add(item);
        }
        return new ArrayList<>(scopes);
    }

    public static void requireScopes(List<String> scopes) throws IOException {
        for (String scope : scopes) if (!REQUESTED_SCOPES.contains(scope))
            throw new IOException("现有 GitHub 授权权限过宽，请使用本项目独立注册的 OAuth App 重新授权。");
        if (!scopes.contains("public_repo") || !scopes.contains("workflow")) throw scopeError();
    }

    private static IOException scopeError() {
        return new IOException("GitHub 授权范围不足，需要公共仓库和工作流权限，请重新授权。");
    }

    public static long deviceLifetimeSeconds(Object value) throws IOException {
        return seconds(value, -1, 3600, "GitHub 返回的设备授权有效期无效，请重新授权。");
    }

    public static long pollIntervalMillis(Object value) throws IOException {
        return Math.max(MIN_POLL_MILLIS, seconds(value, 5, 3600, "GitHub 返回的授权轮询间隔无效，请重新授权。") * 1000);
    }

    /** Missing expires_in means GitHub did not declare an expiry; refresh tokens are not retained. */
    public static long tokenLifetimeSeconds(Object value) throws IOException {
        return seconds(value, 0, 366L * 24 * 60 * 60, "GitHub 返回的凭据有效期无效，请重新授权。");
    }

    private static long seconds(Object value, long fallback, long maximum, String error) throws IOException {
        if (value == null || value == JSONObject.NULL) {
            if (fallback >= 0) return fallback;
            throw new IOException(error);
        }
        if (!(value instanceof Number number)) throw new IOException(error);
        long seconds = number.longValue();
        if (!Double.isFinite(number.doubleValue()) || number.doubleValue() != seconds || seconds < 1 || seconds > maximum)
            throw new IOException(error);
        return seconds;
    }

    public static long deadline(long startMillis, long seconds) throws IOException {
        try { return Math.addExact(startMillis, Math.multiplyExact(seconds, 1000)); }
        catch (ArithmeticException error) { throw new IOException("GitHub 返回的授权有效期无效，请重新授权。"); }
    }

    /** Git normally omits path unless credential.useHttpPath is enabled. */
    public static boolean credentialAllowed(String protocol, String host, String path) {
        if (!"https".equals(protocol) || host == null || !"github.com".equalsIgnoreCase(host)) return false;
        if (path == null || path.isEmpty()) return true;
        if (path.length() > 1024 || !path.matches("/?[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*/?")) return false;
        for (String segment : path.split("/")) if (segment.equals(".") || segment.equals("..")) return false;
        return true;
    }

    public static boolean endpointAllowed(String method, String url) {
        return ("POST".equals(method) && (DEVICE_URL.equals(url) || TOKEN_URL.equals(url)))
            || ("GET".equals(method) && USER_URL.equals(url));
    }
}
