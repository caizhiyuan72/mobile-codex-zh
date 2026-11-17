package dev.mobilecodex.app.core;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.io.IOException;
import static dev.mobilecodex.app.core.Json.*;
import static org.junit.Assert.*;

public class ApiProviderPolicyTest {
    @Test public void httpsBaseUrlsPreserveVersionPathsAndRejectCredentialOrEndpointInput() throws Exception {
        assertEquals("https://example.test/gateway/v1", ApiProviderPolicy.baseUrl("https://example.test/gateway/v1/"));
        for (String invalid : new String[]{"http://example.test/v1", "https://user:key@example.test/v1", "https://example.test/v1?key=x", "https://example.test/#fragment", "https://example.test:0", "https://example.test/v1/responses", "https://example.test/v1/chat/completions"}) {
            try { ApiProviderPolicy.baseUrl(invalid); fail(invalid); } catch (IOException expected) {}
        }
    }
    @Test public void futureProtocolsCannotFallThroughToResponses() throws Exception {
        assertEquals("responses", ApiProviderPolicy.protocol(""));
        try { ApiProviderPolicy.protocol("anthropic_messages"); fail(); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("尚未实现")); }
    }
    @Test public void modelsAreDeduplicatedAndBounded() throws Exception {
        assertEquals("[\"a\",\"org/b\"]", ApiProviderPolicy.models("a\norg/b,a").toString());
        JSONArray tooMany = new JSONArray();
        for (int i = 0; i <= 150; i++) tooMany.put("model-" + i);
        try { ApiProviderPolicy.models(tooMany); fail(); } catch (IOException expected) {}
        try { ApiProviderPolicy.models("model\twith\tspace"); fail(); } catch (IOException expected) {}
    }
    @Test public void runtimeConfigurationKeepsToolsAndSubagentsWithoutCopyingAccountSelection() throws Exception {
        JSONObject profile = obj("name", "Third party", "protocol", "responses", "baseUrl", "https://example.test/v1", "defaultModel", "coding-model");
        String base = "model_provider = \"old\"\nmodel = \"old-model\"\nforced_login_method = \"chatgpt\"\n[features]\nmulti_agent = true\n[agents]\nmax_threads = 2\n[mcp_servers.project]\ncommand = \"python\"\n[model_providers.mobile_api]\nbase_url = \"https://old.test\"\n";
        String generated = ApiProviderPolicy.runtimeConfig(base, profile);
        assertTrue(generated.contains("model_provider = \"mobile_api\""));
        assertTrue(generated.contains("model = \"coding-model\""));
        assertTrue(generated.contains("env_key = \"CODEX_PROVIDER_API_KEY\""));
        assertTrue(generated.contains("requires_openai_auth = false"));
        assertTrue(generated.contains("[features]\nmulti_agent = true"));
        assertTrue(generated.contains("[mcp_servers.project]\ncommand = \"python\""));
        assertFalse(generated.contains("forced_login_method"));
        assertFalse(generated.contains("old-model")); assertFalse(generated.contains("https://old.test"));
    }
    @Test public void quotedMetadataCannotInjectTomlTables() {
        assertEquals("\"name\\\"\\u000a[features]\\\\\"", ApiProviderPolicy.quote("name\"\n[features]\\"));
        assertEquals("\"</script>\"", ApiProviderPolicy.quote("</script>"));
    }
    @Test public void savedModelIdentifiersDoNotPretendToVerifyReasoningOrPriority() throws Exception {
        JSONArray models = ApiProviderPolicy.modelCatalog(obj("models", array("coding-model"), "defaultModel", "coding-model"));
        JSONObject model = models.getJSONObject(0);
        assertTrue(model.getBoolean("isDefault")); assertFalse(model.getBoolean("capabilitiesVerified"));
        assertEquals(0, model.getJSONArray("supportedReasoningEfforts").length());
        assertEquals(0, model.getJSONArray("serviceTiers").length());
    }
}
