package dev.mobilecodex.app.core;

import org.json.JSONObject;
import org.junit.Test;

import java.io.IOException;

import static dev.mobilecodex.app.core.Json.array;
import static dev.mobilecodex.app.core.Json.obj;
import static org.junit.Assert.*;

public class ApiModelDiscoveryTest {
    @Test public void authenticatedModelListHasPrecedence() throws Exception {
        JSONObject result = ApiModelDiscovery.discover("https://gateway.test/v1", "test-key", (url, key) -> {
            assertEquals("https://gateway.test/v1/models", url);
            assertEquals("test-key", key);
            return obj("data", array(obj("id", "org/coder"), obj("id", "org/coder"), obj("id", "invalid id")));
        });
        assertEquals("models", result.getString("source"));
        assertEquals("[\"org/coder\"]", result.getJSONArray("models").toString());
        assertFalse(result.getBoolean("verified"));
        assertFalse(result.has("listIssueStatus"));
    }

    @Test public void publicPricingRetainsGatewayPrefixAndDoesNotReceiveTheKey() throws Exception {
        JSONObject result = ApiModelDiscovery.discover("https://gateway.test/relay/v1", "test-key", (url, key) -> {
            if (url.endsWith("/models")) {
                assertEquals("test-key", key);
                throw new ApiModelDiscovery.HttpStatusException(401);
            }
            assertEquals("https://gateway.test/relay/api/pricing", url);
            assertEquals("", key);
            return obj("success", true, "data", array(
                obj("model_name", "chat-only", "supported_endpoint_types", array("openai")),
                obj("model_name", "responses-model", "supported_endpoint_types", array("openai", "openai-response")),
                obj("model_name", "unknown")));
        });
        assertEquals("publicPricing", result.getString("source"));
        assertEquals("读取模型列表失败（HTTP 401）", result.getString("listIssue"));
        assertEquals(401, result.get("listIssueStatus"));
        assertEquals(3, result.getJSONArray("models").length());
        assertEquals("[\"chat-only\"]", result.getJSONArray("chatOnlyModels").toString());
        assertFalse(result.getBoolean("verified"));
    }

    @Test public void nonHttpFailureHasNoStatusCode() throws Exception {
        JSONObject result = ApiModelDiscovery.discover("https://gateway.test/v1", "test-key", (url, key) -> {
            if (url.endsWith("/models")) throw new IOException("读取模型列表超时");
            assertEquals("", key);
            return obj("success", true, "data", array(obj("model_name", "public-model")));
        });
        assertEquals("publicPricing", result.getString("source"));
        assertEquals("读取模型列表超时", result.getString("listIssue"));
        assertTrue(result.isNull("listIssueStatus"));
    }

    @Test public void failedPublicCatalogDoesNotHideTheOriginalError() throws Exception {
        try {
            ApiModelDiscovery.discover("https://gateway.test/v1", "test-key", (url, key) -> {
                if (url.endsWith("/models")) throw new ApiModelDiscovery.HttpStatusException(403);
                return obj("success", false, "data", array(obj("model_name", "unavailable")));
            });
            fail();
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("HTTP 403"));
        }
    }
}
