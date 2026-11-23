package dev.mobilecodex.app.core;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.net.URI;
import java.util.LinkedHashSet;
import java.util.Set;

/** Provider validation and Responses configuration, independent of Android storage. */
public final class ApiProviderPolicy {
    public static final String RESPONSES = "responses";
    public static final String PROVIDER_ID = "mobile_api";
    public static final String KEY_ENV = "CODEX_PROVIDER_API_KEY";
    public static final int MAX_MODELS = 150;
    private ApiProviderPolicy() {}

    public static String protocol(String value) throws IOException {
        String protocol = value == null || value.isBlank() ? RESPONSES : value.trim();
        if (!RESPONSES.equals(protocol)) throw new IOException("当前版本只支持 Responses 协议；此协议尚未实现：" + protocol);
        return protocol;
    }

    public static String baseUrl(String value) throws IOException {
        return baseUrl(value, false);
    }

    public static String providerUrl(String value) throws IOException {
        return baseUrl(value, true);
    }

    private static String baseUrl(String value, boolean acceptEndpoint) throws IOException {
        try {
            URI uri = new URI(value == null ? "" : value.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getHost().isBlank()
                    || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                    || uri.getPort() == 0 || uri.getPort() > 65535)
                throw new IllegalArgumentException();
            String normalized = uri.normalize().toASCIIString();
            while (normalized.endsWith("/")) normalized = normalized.substring(0, normalized.length() - 1);
            if (normalized.length() > 512) throw new IllegalArgumentException();
            for (String endpoint : new String[]{"/chat/completions", "/responses", "/models"}) {
                if (!normalized.endsWith(endpoint)) continue;
                if (acceptEndpoint) {
                    normalized = normalized.substring(0, normalized.length() - endpoint.length());
                }
                else if (!endpoint.equals("/models")) throw new IOException("请填写 API Base URL，不要包含 /responses 或 /chat/completions。");
                break;
            }
            return normalized;
        } catch (IOException error) { throw error; }
        catch (Exception error) { throw new IOException("请填写 HTTPS 的 API Base URL，不能包含账号、查询参数或片段。", error); }
    }

    public static JSONArray models(Object value) throws IOException {
        Set<String> ids = new LinkedHashSet<>();
        if (value instanceof JSONArray array) {
            for (int i = 0; i < array.length(); i++) {
                if (!(array.opt(i) instanceof String)) throw new IOException("模型 ID 必须是文本。");
                addModel(ids, array.optString(i));
            }
        } else if (value instanceof String text) {
            for (String id : text.split("[\\r\\n,]")) addModel(ids, id);
        } else throw new IOException("请填写至少一个模型 ID。");
        if (ids.isEmpty()) throw new IOException("请填写至少一个模型 ID。");
        return new JSONArray(ids);
    }

    private static void addModel(Set<String> ids, String value) throws IOException {
        String id = value.trim();
        if (id.isEmpty()) return;
        if (!validModelId(id))
            throw new IOException("模型 ID 不能包含空白或控制字符，最长 200 个字符。");
        ids.add(id);
        if (ids.size() > MAX_MODELS) throw new IOException("最多可保存 150 个模型。");
    }

    static boolean validModelId(String id) {
        return !id.isEmpty() && id.length() <= 200
            && id.chars().noneMatch(character -> Character.isISOControl(character) || Character.isWhitespace(character));
    }

    public static String apiKey(String value) throws IOException {
        String key = value == null ? "" : value.trim();
        if (key.isEmpty() || key.length() > 4096 || key.chars().anyMatch(c -> Character.isISOControl(c) || Character.isWhitespace(c)))
            throw new IOException("API Key 不能为空，且不能包含空白或控制字符。");
        return key;
    }

    /** The base config remains editable; app-owned connection keys are rebuilt on each start. */
    public static String runtimeConfig(String base, JSONObject profile) throws IOException {
        protocol(profile.optString("protocol"));
        StringBuilder preserved = new StringBuilder();
        boolean root = true, reservedTable = false;
        Set<String> owned = Set.of("model", "model_provider", "forced_login_method", "cli_auth_credentials_store");
        for (String line : (base == null ? "" : base).split("\\r?\\n", -1)) {
            String trimmed = line.trim();
            if (trimmed.startsWith("[")) {
                root = false;
                String table = trimmed.replace("\"", "").replace("'", "").replace(" ", "");
                reservedTable = table.startsWith("[model_providers." + PROVIDER_ID + "]")
                    || table.startsWith("[model_providers." + PROVIDER_ID + ".");
            }
            if (reservedTable) continue;
            int equals = trimmed.indexOf('=');
            String key = equals < 0 ? "" : trimmed.substring(0, equals).trim().replace("\"", "").replace("'", "");
            if (root && (owned.contains(key) || key.startsWith("model_providers." + PROVIDER_ID + "."))) continue;
            preserved.append(line).append('\n');
        }
        return "# Connection managed by the app; API keys are supplied through the process environment.\n"
            + "model_provider = " + quote(PROVIDER_ID) + "\n"
            + "model = " + quote(profile.optString("defaultModel")) + "\n"
            + "cli_auth_credentials_store = \"file\"\n"
            + preserved + "\n[model_providers." + PROVIDER_ID + "]\n"
            + "name = " + quote(profile.optString("name")) + "\n"
            + "base_url = " + quote(baseUrl(profile.optString("baseUrl"))) + "\n"
            + "env_key = " + quote(KEY_ENV) + "\n"
            + "wire_api = \"responses\"\nrequires_openai_auth = false\n";
    }

    public static String quote(String value) {
        StringBuilder result = new StringBuilder("\"");
        for (char c : (value == null ? "" : value).toCharArray()) {
            if (c == '\\' || c == '"') result.append('\\').append(c);
            else if (Character.isISOControl(c)) result.append(String.format(java.util.Locale.ROOT, "\\u%04x", (int) c));
            else result.append(c);
        }
        return result.append('"').toString();
    }

    /** A directory scan establishes identifiers only, never reasoning or priority support. */
    public static JSONArray modelCatalog(JSONObject profile) {
        JSONArray result = new JSONArray(), ids = profile.optJSONArray("models");
        if (ids == null) return result;
        for (int i = 0; i < ids.length(); i++) {
            String id = ids.optString(i);
            result.put(Json.obj("id", id, "model", id, "displayName", id,
                "isDefault", id.equals(profile.optString("defaultModel")),
                "supportedReasoningEfforts", new JSONArray(), "defaultReasoningEffort", "",
                "serviceTiers", new JSONArray(), "capabilitiesVerified", false));
        }
        return result;
    }
}
