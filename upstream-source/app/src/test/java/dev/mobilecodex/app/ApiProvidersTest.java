package dev.mobilecodex.app;

import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;
import dev.mobilecodex.app.core.ApiProviderPolicy;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.*;
import static dev.mobilecodex.app.core.Json.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 29, application = Application.class)
public class ApiProvidersTest {
    private Context context;
    private SharedPreferences preferences, legacy;
    private File root;
    private ApiProviders providers;
    private Engine engine;
    private static final String FIXTURE_KEY = "sk-fixture-never-a-real-key";
    private static final SecretKeySpec SECRET = new SecretKeySpec(new byte[16], "AES");
    static final class FixtureCipher implements ApiProviders.KeyCipher {
        public JSONObject seal(String text) throws Exception {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, SECRET);
            return obj("iv", Base64.getEncoder().encodeToString(cipher.getIV()), "ciphertext", Base64.getEncoder().encodeToString(cipher.doFinal(text.getBytes(StandardCharsets.UTF_8))));
        }
        public String open(JSONObject encrypted) throws Exception {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, SECRET, new GCMParameterSpec(128, Base64.getDecoder().decode(encrypted.getString("iv"))));
            return new String(cipher.doFinal(Base64.getDecoder().decode(encrypted.getString("ciphertext"))), StandardCharsets.UTF_8);
        }
    }
    @Before public void before() throws Exception {
        context = RuntimeEnvironment.getApplication();
        preferences = context.getSharedPreferences("provider-regression-tests", 0); preferences.edit().clear().commit();
        legacy = context.getSharedPreferences("legacy-provider-regression-tests", 0); legacy.edit().clear().commit();
        root = new File(context.getCacheDir(), "api-tests-" + UUID.randomUUID());
        providers = new ApiProviders(preferences, new FixtureCipher(), new File(root, "runtime"));
        for (String name : new String[]{"projects", "workspace", "settings", "api-providers-v2", "api_provider_profiles_v1"}) context.getSharedPreferences(name, 0).edit().clear().commit();
        Files.deleteIfExists(new File(context.getFilesDir(), "sessions.json").toPath());
    }
    @After public void after() throws Exception {
        if (engine != null) engine.io.shutdownNow();
        preferences.edit().clear().commit(); legacy.edit().clear().commit();
        if (root.exists()) try (java.util.stream.Stream<java.nio.file.Path> paths = Files.walk(root.toPath())) {
            for (java.nio.file.Path path : paths.sorted(Comparator.reverseOrder()).collect(java.util.stream.Collectors.toList())) Files.deleteIfExists(path);
        }
        Files.deleteIfExists(new File(context.getFilesDir(), "sessions.json").toPath());
    }
    private String save(String name) throws Exception {
        return providers.save(obj("name", name, "baseUrl", "https://example.test/v1", "models", "coding-model\nsecond-model", "apiKey", FIXTURE_KEY, "protocol", "responses")).getString("id");
    }
    private JSONObject handle(String action, JSONObject args) throws Exception {
        CompletableFuture<JSONObject> completed = new CompletableFuture<>();
        engine.handle(action, args, (result, error) -> { if (error == null) completed.complete(result); else completed.completeExceptionally(error); });
        return completed.get(5, TimeUnit.SECONDS);
    }
    @Test public void encryptedPersistenceAndPublicSnapshotsNeverExposeKeys() throws Exception {
        String id = save("Gateway"); providers.select(id);
        String persisted = preferences.getString("registry", "");
        assertFalse(persisted.contains(FIXTURE_KEY));
        assertFalse(providers.snapshot().toString().contains("ciphertext"));
        assertFalse(providers.snapshot().toString().contains(FIXTURE_KEY));
        ApiProviders reopened = new ApiProviders(preferences, new FixtureCipher(), new File(root, "runtime"));
        assertEquals(id, reopened.activeId()); assertEquals(FIXTURE_KEY, reopened.activeKey());
    }
    @Test public void blankEditKeyPreservesCredentialAndUnknownProtocolCannotOverwriteIt() throws Exception {
        String id = save("Gateway"); providers.select(id);
        providers.save(obj("id", id, "name", "Renamed", "baseUrl", "https://example.test/v1", "models", "second-model", "apiKey", ""));
        assertEquals(FIXTURE_KEY, providers.activeKey());
        String before = preferences.getString("registry", "");
        try { providers.save(obj("id", id, "name", "Unsupported", "baseUrl", "https://example.test/v1", "models", "model", "protocol", "anthropic_messages")); fail(); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("尚未实现")); }
        assertEquals(before, preferences.getString("registry", ""));
    }
    @Test public void editingAddressCannotSilentlyReuseSavedKeyForDiscovery() throws Exception {
        String id = save("Gateway");
        try { providers.discover(obj("id", id, "baseUrl", "https://another.test/v1")); fail(); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("修改地址后")); }
    }
    @Test public void editingAddressRequiresAnExplicitNewKeyBeforePersistence() throws Exception {
        String id = save("Gateway"); providers.select(id);
        String before = preferences.getString("registry", "");
        try { providers.save(obj("id", id, "name", "Changed", "baseUrl", "https://another.test/v1", "models", "coding-model", "apiKey", "")); fail(); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("重新填写")); }
        assertEquals(before, preferences.getString("registry", ""));
        assertEquals(FIXTURE_KEY, providers.activeKey());
    }
    @Test public void providerAndCredentialRevisionsUseSeparateHomesWithoutAuthJson() throws Exception {
        String one = save("First"), two = save("Second");
        File base = new File(root, "base"); base.mkdirs();
        Files.write(new File(base, "config.toml").toPath(), "[features]\nmulti_agent=true\n[agents]\nmax_threads=2\n".getBytes(StandardCharsets.UTF_8));
        Files.write(new File(base, "auth.json").toPath(), "subscription-data-must-not-be-copied".getBytes(StandardCharsets.UTF_8));
        providers.select(one); File first = providers.prepareHome(base);
        String firstScope = providers.scope();
        providers.save(obj("id", one, "name", "Renamed only", "baseUrl", "https://example.test/v1", "models", "coding-model,another-model", "defaultModel", "another-model", "apiKey", ""));
        assertEquals(firstScope, providers.scope()); assertEquals(first, providers.prepareHome(base));
        providers.select(two); File second = providers.prepareHome(base); assertNotEquals(first, second);
        providers.save(obj("id", two, "name", "Changed", "baseUrl", "https://new.test/v1", "models", "new-model", "apiKey", "replacement-fixture-key"));
        File changed = providers.prepareHome(base); assertNotEquals(second, changed);
        assertFalse(new File(changed, "auth.json").exists());
        String config = new String(Files.readAllBytes(new File(changed, "config.toml").toPath()), StandardCharsets.UTF_8);
        assertTrue(config.contains("https://new.test/v1")); assertTrue(config.contains("multi_agent=true"));
        assertFalse(config.contains(FIXTURE_KEY)); assertFalse(config.contains("replacement-fixture-key"));
    }
    @Test public void removingActiveProfileClearsSelectionAndStoredCredential() throws Exception {
        String id = save("Gateway"); providers.select(id); providers.remove(id);
        assertEquals("", providers.activeId()); assertFalse(providers.configured());
        assertEquals(0, providers.snapshot().getJSONArray("apiProviders").length());
        assertFalse(preferences.getString("registry", "").contains("ciphertext"));
    }
    @Test public void realV5PayloadFormatMigratesAtomicallyWithoutReturningPlaintext() throws Exception {
        JSONArray old = array(obj("id", "api_abcdef012345", "name", "Legacy", "baseUrl", "https://example.test/v1", "models", array("coding-model"), "key", FIXTURE_KEY));
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, SECRET);
        byte[] encrypted = cipher.doFinal(old.toString().getBytes(StandardCharsets.UTF_8));
        byte[] packed = new byte[12 + encrypted.length];
        System.arraycopy(cipher.getIV(), 0, packed, 0, 12); System.arraycopy(encrypted, 0, packed, 12, encrypted.length);
        legacy.edit().putString("encrypted", Base64.getEncoder().encodeToString(packed)).putString("active", "api_abcdef012345").commit();
        providers.migrateLegacy(legacy, payload -> ApiProviders.decodeLegacy(payload, SECRET));
        assertEquals("api_abcdef012345", providers.activeId()); assertEquals(FIXTURE_KEY, providers.activeKey());
        assertFalse(legacy.contains("encrypted")); assertFalse(providers.snapshot().toString().contains(FIXTURE_KEY));
        assertFalse(preferences.getString("registry", "").contains(FIXTURE_KEY));
    }
    @Test public void failedV5MigrationPreservesOriginalCiphertextAndRemainsEditable() throws Exception {
        legacy.edit().putString("encrypted", "original-encrypted-fixture").putString("active", "api_abcdef012345").commit();
        providers.migrateLegacy(legacy, payload -> { throw new IOException("missing keystore fixture"); });
        assertEquals("original-encrypted-fixture", legacy.getString("encrypted", ""));
        assertFalse(preferences.contains("registry"));
        assertFalse(providers.snapshot().getString("apiMigrationError").isBlank());
        assertNotNull(save("Fresh configuration"));
    }
    @Test public void apiConfigurationCanSendWithoutChatgptLoginAndModelsRefreshDoesNotPollAccounts() throws Exception {
        String id = save("Gateway"); providers.select(id); engine = new Engine(context, providers);
        List<String> calls = new ArrayList<>();
        engine.setTestTransport((method, params) -> {
            calls.add(method); assertFalse(method.startsWith("account/"));
            if (method.equals("thread/start")) { assertEquals(ApiProviderPolicy.PROVIDER_ID, params.getString("modelProvider")); return obj("thread", obj("id", "api-remote")); }
            if (method.equals("turn/start")) return obj("turn", obj("id", ""));
            throw new AssertionError(method);
        });
        assertEquals(2, handle("models.refresh", obj()).getJSONArray("models").length());
        handle("chat.send", obj("text", "Read the project"));
        assertEquals(Arrays.asList("thread/start", "turn/start"), calls);
        JSONObject snapshot = handle("state", obj());
        assertEquals("configured", snapshot.getString("authState"));
        assertFalse(snapshot.toString().contains(FIXTURE_KEY));
        assertFalse(snapshot.has("rateLimits")); assertFalse(snapshot.has("pendingProConsultation"));
    }
    @Test public void providerSwitchStartsNewChatAndCannotResumeOldProviderThread() throws Exception {
        String one = save("First"), two = save("Second"); providers.select(one); engine = new Engine(context, providers);
        List<String> calls = new ArrayList<>();
        engine.setTestTransport((method, params) -> {
            calls.add(method);
            if (method.equals("thread/start")) return obj("thread", obj("id", "first-provider-thread"));
            if (method.equals("turn/start")) return obj("turn", obj("id", ""));
            if (method.equals("thread/resume")) { assertEquals("first-provider-thread", params.getString("threadId")); return obj(); }
            throw new AssertionError("Cross-provider runtime call: " + method);
        });
        handle("chat.send", obj("text", "First provider"));
        String local = handle("state", obj()).getString("threadId");
        handle("providers.save", obj("id", one, "name", "Renamed provider", "baseUrl", "https://example.test/v1", "models", "coding-model,second-model", "apiKey", ""));
        assertEquals(local, handle("state", obj()).getString("threadId"));
        handle("providers.select", obj("id", one));
        assertEquals(local, handle("state", obj()).getString("threadId"));
        assertEquals(Arrays.asList("thread/start", "turn/start", "thread/resume"), calls);
        handle("providers.select", obj("id", two));
        assertEquals("", handle("state", obj()).getString("threadId"));
        assertEquals(1, handle("state", obj()).getJSONArray("sessions").length());
        handle("chat.resume", obj("id", local));
        int before = calls.size();
        try { handle("rpc", obj("method", "thread/resume", "params", obj("threadId", local))); fail(); }
        catch (ExecutionException expected) { assertTrue(expected.getCause().getMessage().contains("其他 API 配置")); }
        try { handle("rpc", obj("method", "thread/read", "params", obj("threadId", "untracked-remote-id"))); fail(); }
        catch (ExecutionException expected) { assertTrue(expected.getCause().getMessage().contains("找不到")); }
        try { handle("chat.send", obj("text", "Cannot send with another credential")); fail(); }
        catch (ExecutionException expected) { assertTrue(expected.getCause().getMessage().contains("其他 API 配置")); }
        assertEquals(before, calls.size());
    }
    @Test public void retiredRoutesNeverReachAppServerEvenThroughGenericRpc() throws Exception {
        engine = new Engine(context, providers);
        engine.setTestTransport((method, params) -> { throw new AssertionError(method); });
        for (String action : new String[]{"auth.login", "agents.provider.login", "live.start", "chat.pro.prepare"}) {
            try { handle(action, obj()); fail(action); } catch (ExecutionException expected) {}
        }
        try { handle("rpc", obj("method", "account/rateLimits/read")); fail(); }
        catch (ExecutionException expected) { assertTrue(expected.getCause().getMessage().contains("不支持")); }
    }
}
