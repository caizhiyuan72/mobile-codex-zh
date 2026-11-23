package dev.mobilecodex.app.core;

import org.json.JSONArray;
import org.json.JSONObject;

import javax.net.ssl.HttpsURLConnection;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Set;

import static dev.mobilecodex.app.core.Json.obj;

public final class ApiModelDiscovery {
    interface Fetcher { JSONObject get(String url, String apiKey) throws IOException; }

    static final class HttpStatusException extends IOException {
        final int status;

        HttpStatusException(int status) {
            super("读取模型列表失败（HTTP " + status + "）");
            this.status = status;
        }
    }

    private static final int MAX_BYTES = 2 * 1024 * 1024;
    private static final int MAX_MODELS = 2000;

    private ApiModelDiscovery() {}

    public static JSONObject discover(String baseUrl, String apiKey) throws IOException {
        return discover(baseUrl, apiKey, ApiModelDiscovery::get);
    }

    static JSONObject discover(String baseUrl, String apiKey, Fetcher fetcher) throws IOException {
        IOException listError;
        try {
            JSONObject response = fetcher.get(baseUrl + "/models", apiKey);
            Set<String> models = readModels(response.optJSONArray("data"), "id");
            if (!models.isEmpty() && !response.has("error"))
                return obj("models", new JSONArray(models), "source", "models", "verified", false);
            throw new IOException("密钥接口未返回有效的模型列表");
        } catch (IOException error) {
            listError = error;
        }
        if (baseUrl.endsWith("/v1")) {
            String catalogUrl = baseUrl.substring(0, baseUrl.length() - "/v1".length()) + "/api/pricing";
            try {
                JSONObject catalog = fetcher.get(catalogUrl, "");
                JSONArray rows = catalog.optJSONArray("data");
                Set<String> models = readModels(rows, "model_name");
                if (catalog.optBoolean("success") && !models.isEmpty())
                    return obj("models", new JSONArray(models), "source", "publicPricing", "listIssue", listError.getMessage(),
                        "listIssueStatus", listError instanceof HttpStatusException httpError ? httpError.status : null,
                        "chatOnlyModels", chatOnlyModels(rows, models), "verified", false);
            } catch (IOException ignored) {}
        }
        throw new IOException(listError.getMessage() + "。请检查接口地址和密钥，也可以手动填写模型 ID。", listError);
    }

    private static String modelId(JSONObject row, String field) {
        return row != null && row.opt(field) instanceof String id ? id.trim() : "";
    }

    private static Set<String> readModels(JSONArray rows, String field) {
        Set<String> models = new LinkedHashSet<>();
        for (int index = 0; rows != null && index < rows.length() && models.size() < MAX_MODELS; index++) {
            String id = modelId(rows.optJSONObject(index), field);
            if (ApiProviderPolicy.validModelId(id)) models.add(id);
        }
        return models;
    }

    private static JSONArray chatOnlyModels(JSONArray rows, Set<String> models) {
        Set<String> chat = new LinkedHashSet<>(), other = new LinkedHashSet<>();
        for (int index = 0; index < rows.length(); index++) {
            JSONObject row = rows.optJSONObject(index);
            String id = modelId(row, "model_name");
            if (!models.contains(id)) continue;
            JSONArray endpoints = row.optJSONArray("supported_endpoint_types");
            if (endpoints != null && endpoints.length() == 1 && "openai".equals(endpoints.optString(0))) chat.add(id);
            else other.add(id);
        }
        chat.removeAll(other);
        return new JSONArray(chat);
    }

    private static JSONObject get(String url, String apiKey) throws IOException {
        HttpsURLConnection connection = null;
        try {
            connection = (HttpsURLConnection) new URL(url).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(12000);
            connection.setRequestProperty("Accept", "application/json");
            if (!apiKey.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + apiKey);
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new HttpStatusException(status);
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] block = new byte[8192];
                int length;
                while ((length = input.read(block)) != -1) {
                    if (buffer.size() + length > MAX_BYTES) throw new IOException("模型列表响应过大");
                    buffer.write(block, 0, length);
                }
            }
            return new JSONObject(buffer.toString(StandardCharsets.UTF_8.name()));
        } catch (org.json.JSONException error) {
            throw new IOException("接口返回的内容不是 JSON 模型列表");
        } catch (java.net.SocketTimeoutException error) {
            throw new IOException("读取模型列表超时");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
