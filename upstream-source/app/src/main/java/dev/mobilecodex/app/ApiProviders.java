package dev.mobilecodex.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import dev.mobilecodex.app.core.ApiProviderPolicy;
import dev.mobilecodex.app.core.Utf8Files;
import org.json.JSONArray;
import org.json.JSONObject;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.HttpsURLConnection;
import java.io.*;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.KeyStore;
import java.util.*;
import static dev.mobilecodex.app.core.Json.obj;

/** Private provider registry. Public methods never return stored API credentials. */
final class ApiProviders {
    interface KeyCipher { JSONObject seal(String key) throws Exception; String open(JSONObject sealed) throws Exception; }
    interface LegacyDecoder { JSONArray decode(String payload) throws Exception; }
    private static final String STORE = "registry";
    private final SharedPreferences preferences;
    private final KeyCipher cipher;
    private final File runtimeRoot;
    private JSONObject registry;
    private String migrationError = "";

    ApiProviders(Context context) throws IOException {
        this(context.getSharedPreferences("api-providers-v2", Context.MODE_PRIVATE),
            new AndroidKeyCipher(), new File(context.getFilesDir(), "api-runtime"));
        migrateLegacy(context.getSharedPreferences("api_provider_profiles_v1", Context.MODE_PRIVATE), payload -> {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
            String alias = "mobile_codex_zhcn_api_providers_1";
            if (!store.containsAlias(alias)) throw new IOException("旧版密钥不可用。");
            return decodeLegacy(payload, (SecretKey) store.getKey(alias, null));
        });
    }
    ApiProviders(SharedPreferences preferences, KeyCipher cipher, File runtimeRoot) throws IOException {
        this.preferences = preferences; this.cipher = cipher; this.runtimeRoot = runtimeRoot;
        try { registry = new JSONObject(preferences.getString(STORE, "{\"profiles\":[],\"active\":\"\"}")); }
        catch (Exception error) { throw new IOException("无法读取 API 配置，原有数据已保留。", error); }
        if (registry.optJSONArray("profiles") == null) throw new IOException("API 配置格式无效，原有数据已保留。");
        JSONArray profiles = registry.optJSONArray("profiles");
        for (int i = 0; i < profiles.length(); i++) {
            JSONObject profile = profiles.optJSONObject(i);
            if (profile == null || !validId(profile.optString("id"))) throw new IOException("API 配置格式无效，原有数据已保留。");
        }
    }

    /** V5 stores Base64(12-byte IV || GCM ciphertext) under its original Keystore alias. */
    static JSONArray decodeLegacy(String payload, SecretKey secret) throws Exception {
        byte[] packed = Base64.getDecoder().decode(payload);
        if (packed.length < 29) throw new IOException("旧版 API 加密数据无效。");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, secret, new GCMParameterSpec(128, Arrays.copyOfRange(packed, 0, 12)));
        return new JSONArray(new String(cipher.doFinal(packed, 12, packed.length - 12), StandardCharsets.UTF_8));
    }
    synchronized void migrateLegacy(SharedPreferences legacy, LegacyDecoder decoder) {
        String encrypted = legacy.getString("encrypted", "");
        if (encrypted.isBlank()) return;
        if (preferences.contains(STORE)) {
            if (registry.optBoolean("legacyMigrated")) legacy.edit().remove("encrypted").remove("active").commit();
            return;
        }
        try {
            JSONArray old = decoder.decode(encrypted), profiles = new JSONArray();
            if (old.length() > 25) throw new IOException("旧版服务商数量无效。");
            Set<String> seen = new HashSet<>();
            for (int i = 0; i < old.length(); i++) {
                JSONObject profile = old.getJSONObject(i);
                String id = profile.getString("id"), name = profile.getString("name");
                if (!validId(id) || !seen.add(id) || name.isBlank() || name.length() > 60) throw new IOException("旧版服务商格式无效。");
                JSONArray models = ApiProviderPolicy.models(profile.getJSONArray("models"));
                profiles.put(obj("id", id, "name", name, "protocol", ApiProviderPolicy.RESPONSES,
                    "baseUrl", ApiProviderPolicy.baseUrl(profile.getString("baseUrl")), "models", models,
                    "defaultModel", models.optString(0), "revision", 1,
                    "credential", cipher.seal(ApiProviderPolicy.apiKey(profile.getString("key")))));
            }
            String active = legacy.getString("active", "");
            commit(obj("profiles", profiles, "active", seen.contains(active) ? active : "", "legacyMigrated", true));
            // Clear the old ciphertext only after the whole new registry is durable.
            legacy.edit().remove("encrypted").remove("active").commit();
        } catch (Exception error) {
            migrationError = "旧版 API 设置未能迁移，原数据已保留。请重新填写服务商与密钥。";
        }
    }

    synchronized String activeId() { return registry.optString("active"); }
    synchronized boolean configured() { return profile(activeId()) != null; }
    synchronized JSONObject activeProfile() throws IOException { return profileDetails(activeId()); }
    synchronized JSONObject profileDetails(String id) throws IOException { return publicProfile(require(id)); }
    synchronized String scope() { return scope(activeId()); }
    synchronized String scope(String id) {
        JSONObject profile = profile(id);
        return profile == null ? "" : id + ":" + profile.optLong("revision", 1);
    }
    synchronized JSONObject snapshot() {
        JSONArray profiles = new JSONArray(), stored = registry.optJSONArray("profiles");
        for (int i = 0; i < stored.length(); i++) profiles.put(publicProfile(stored.optJSONObject(i)));
        return obj("apiProviders", profiles, "apiActive", activeId(), "apiMigrationError", migrationError);
    }
    synchronized JSONObject save(JSONObject args) throws IOException {
        String id = args.optString("id").trim();
        JSONObject previous = id.isEmpty() ? null : require(id);
        if (previous == null && registry.optJSONArray("profiles").length() >= 25) throw new IOException("最多可保存 25 个服务商。");
        if (id.isEmpty()) id = "api-" + UUID.randomUUID();
        String name = args.optString("name").trim();
        if (name.isEmpty() || name.length() > 60 || name.chars().anyMatch(Character::isISOControl)) throw new IOException("服务商名称应为 1 至 60 个字符。");
        String protocol = ApiProviderPolicy.protocol(args.optString("protocol", previous == null ? "responses" : previous.optString("protocol", "responses")));
        String baseUrl = ApiProviderPolicy.baseUrl(args.optString("baseUrl"));
        if (previous != null && !baseUrl.equals(previous.optString("baseUrl")) && args.optString("apiKey").isBlank())
            throw new IOException("修改地址后，请重新填写该地址的 API Key。");
        JSONArray models = ApiProviderPolicy.models(args.opt("models"));
        String defaultModel = args.optString("defaultModel", previous == null ? "" : previous.optString("defaultModel"));
        boolean found = false;
        for (int i = 0; i < models.length(); i++) if (defaultModel.equals(models.optString(i))) found = true;
        if (!found) defaultModel = models.optString(0);
        JSONObject encrypted = previous == null ? null : previous.optJSONObject("credential");
        boolean replacingKey = !args.optString("apiKey").isBlank();
        if (replacingKey) {
            try { encrypted = cipher.seal(ApiProviderPolicy.apiKey(args.optString("apiKey"))); }
            catch (IOException error) { throw error; }
            catch (Exception error) { throw new IOException("无法加密 API Key，请重试。", error); }
        }
        if (encrypted == null) throw new IOException("请填写 API Key。");
        boolean connectionChanged = previous == null || replacingKey || !protocol.equals(previous.optString("protocol", "responses"))
            || !baseUrl.equals(previous.optString("baseUrl"));
        JSONObject replacement = obj("id", id, "name", name, "protocol", protocol, "baseUrl", baseUrl,
            "models", models, "defaultModel", defaultModel, "credential", encrypted,
            "revision", previous == null ? 1 : previous.optLong("revision", 1) + (connectionChanged ? 1 : 0));
        JSONObject next = copy(registry); JSONArray list = next.optJSONArray("profiles");
        int index = index(id);
        try { if (index < 0) list.put(replacement); else list.put(index, replacement); }
        catch (Exception error) { throw new IOException("无法保存服务商。", error); }
        commit(next);
        return obj("id", id);
    }
    synchronized void select(String id) throws IOException {
        if (!id.isBlank()) { require(id); key(id); }
        JSONObject next = copy(registry);
        try { next.put("active", id); } catch (Exception error) { throw new IOException(error); }
        commit(next);
    }
    synchronized void remove(String id) throws IOException {
        require(id);
        JSONObject next = copy(registry); JSONArray list = next.optJSONArray("profiles");
        list.remove(index(id));
        try { if (id.equals(activeId())) next.put("active", ""); } catch (Exception error) { throw new IOException(error); }
        commit(next);
    }
    synchronized String activeKey() throws IOException { return key(activeId()); }
    synchronized String key(String id) throws IOException {
        JSONObject profile = require(id);
        try { return ApiProviderPolicy.apiKey(cipher.open(profile.getJSONObject("credential"))); }
        catch (Exception error) { throw new IOException("无法解密 API Key，请重新填写该服务商的密钥。", error); }
    }

    /** Each connection revision has its own server history and cannot resume another credential's threads. */
    synchronized File prepareHome(File baseHome) throws IOException { return prepareHome(baseHome, activeId()); }
    synchronized File prepareHome(File baseHome, String id) throws IOException {
        JSONObject profile = profileDetails(id);
        File home = new File(runtimeRoot, id + "-" + require(id).optLong("revision", 1));
        Files.createDirectories(home.toPath());
        File baseConfig = new File(baseHome, "config.toml");
        String source = baseConfig.isFile() ? Utf8Files.read(baseConfig.toPath()) : "approval_policy = \"on-request\"\n";
        Utf8Files.write(new File(home, "config.toml").toPath(), ApiProviderPolicy.runtimeConfig(source, profile));
        // Share explicitly installed tools without sharing account credentials or server threads.
        for (String name : new String[]{"skills", "plugins", "rules"}) {
            File original = new File(baseHome, name), target = new File(home, name);
            if (original.isDirectory() && !Files.exists(target.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS))
                Files.createSymbolicLink(target.toPath(), original.toPath());
        }
        File instructions = new File(baseHome, "AGENTS.md"), target = new File(home, "AGENTS.md");
        if (instructions.isFile()) Files.copy(instructions.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
        else Files.deleteIfExists(target.toPath());
        return home;
    }

    JSONObject discover(JSONObject args) throws IOException {
        ApiProviderPolicy.protocol(args.optString("protocol"));
        String baseUrl = ApiProviderPolicy.baseUrl(args.optString("baseUrl")), apiKey = args.optString("apiKey");
        if (apiKey.isBlank()) {
            synchronized (this) {
                JSONObject saved = require(args.optString("id"));
                if (!baseUrl.equals(saved.optString("baseUrl"))) throw new IOException("修改地址后，请填写该地址的 API Key 再扫描模型。");
                apiKey = key(saved.optString("id"));
            }
        }
        apiKey = ApiProviderPolicy.apiKey(apiKey);
        HttpsURLConnection connection = null;
        try {
            connection = (HttpsURLConnection) new URL(baseUrl + "/models").openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(12000); connection.setReadTimeout(12000);
            connection.setRequestProperty("Authorization", "Bearer " + apiKey);
            connection.setRequestProperty("Accept", "application/json");
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new IOException("读取模型列表失败（HTTP " + status + "），请检查地址、密钥或手动填写模型。");
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] block = new byte[8192]; int length;
                while ((length = input.read(block)) != -1) {
                    if (buffer.size() + length > 2 * 1024 * 1024) throw new IOException("模型列表响应过大，请手动填写模型 ID。");
                    buffer.write(block, 0, length);
                }
            }
            JSONObject response = new JSONObject(buffer.toString(StandardCharsets.UTF_8.name()));
            JSONArray data = response.optJSONArray("data"), result = new JSONArray(); Set<String> seen = new LinkedHashSet<>();
            if (data == null) throw new IOException("模型列表格式无效，请手动填写模型 ID。");
            for (int i = 0; i < data.length() && seen.size() < 2000; i++) {
                JSONObject model = data.optJSONObject(i); String id = model == null ? "" : model.optString("id");
                if (!id.isBlank() && id.length() <= 200 && id.chars().noneMatch(Character::isISOControl) && seen.add(id)) result.put(id);
            }
            return obj("models", result, "verified", false);
        } catch (IOException error) { throw error; }
        catch (Exception error) { throw new IOException("读取模型列表失败，请检查 Responses API 地址或手动填写模型 ID。"); }
        finally { if (connection != null) connection.disconnect(); }
    }

    private JSONObject profile(String id) {
        int index = index(id); return index < 0 ? null : registry.optJSONArray("profiles").optJSONObject(index);
    }
    private int index(String id) {
        JSONArray profiles = registry.optJSONArray("profiles");
        for (int i = 0; i < profiles.length(); i++) if (id.equals(profiles.optJSONObject(i).optString("id"))) return i;
        return -1;
    }
    private JSONObject require(String id) throws IOException {
        JSONObject profile = profile(id);
        if (profile == null) throw new IOException("请先在设置中添加并启用 API 服务商。");
        return profile;
    }
    private static boolean validId(String value) { return value != null && value.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,80}"); }
    private JSONObject publicProfile(JSONObject profile) {
        if (profile == null) return obj();
        return obj("id", profile.optString("id"), "name", profile.optString("name"), "protocol", profile.optString("protocol", "responses"),
            "baseUrl", profile.optString("baseUrl"), "models", copyArray(profile.optJSONArray("models")),
            "defaultModel", profile.optString("defaultModel"), "hasKey", profile.optJSONObject("credential") != null);
    }
    private void commit(JSONObject next) throws IOException {
        if (!preferences.edit().putString(STORE, next.toString()).commit()) throw new IOException("无法保存 API 配置，原有配置未变更。");
        registry = next;
    }
    private static JSONObject copy(JSONObject value) throws IOException {
        try { return new JSONObject(value.toString()); } catch (Exception error) { throw new IOException(error); }
    }
    private static JSONArray copyArray(JSONArray value) {
        try { return value == null ? new JSONArray() : new JSONArray(value.toString()); } catch (Exception error) { return new JSONArray(); }
    }
    private static final class AndroidKeyCipher implements KeyCipher {
        private static final String ALIAS = "mobile-codex.api-providers.v2";
        private SecretKey secretKey() throws Exception {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
            if (!store.containsAlias(ALIAS)) {
                KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true).build());
                generator.generateKey();
            }
            return (SecretKey) store.getKey(ALIAS, null);
        }
        public JSONObject seal(String key) throws Exception {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, secretKey());
            return obj("iv", Base64.getEncoder().encodeToString(cipher.getIV()),
                "ciphertext", Base64.getEncoder().encodeToString(cipher.doFinal(key.getBytes(StandardCharsets.UTF_8))));
        }
        public String open(JSONObject sealed) throws Exception {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, Base64.getDecoder().decode(sealed.getString("iv"))));
            return new String(cipher.doFinal(Base64.getDecoder().decode(sealed.getString("ciphertext"))), StandardCharsets.UTF_8);
        }
    }
}
