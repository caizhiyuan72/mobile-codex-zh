package dev.mobilecodex.app;

import android.app.Application;
import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceResponse;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 29, application = Application.class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class ChatIconAssetTest {
    @Test public void everyStylesheetAndScriptLinkedFromThePagePassesTheWebViewRoute() throws Exception {
        AssetManager assets = RuntimeEnvironment.getApplication().getAssets();
        String html;
        try (java.io.InputStream input = assets.open("web/index.html")) {
            html = new String(input.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
        java.util.regex.Matcher links = java.util.regex.Pattern.compile("(?:href|src)=\"([^\"#]+\\.(?:css|js))\"").matcher(html);
        int count = 0;
        boolean designStylesheet = false;
        while (links.find()) {
            String path = "/" + links.group(1);
            WebResourceResponse response = MainActivity.packagedUiResponse(assets,
                Uri.parse("https://appassets.androidplatform.net" + path));
            assertEquals(path, 200, response.getStatusCode());
            assertEquals(path, path.endsWith(".css") ? "text/css" : "application/javascript", response.getMimeType());
            try (java.io.InputStream input = response.getData()) { assertTrue(path, input.read() >= 0); }
            designStylesheet |= path.equals("/visual-system.css");
            count++;
        }
        assertTrue("The linked design stylesheet must be served", designStylesheet);
        assertTrue("The page's linked assets were checked", count > 1);
    }

    @Test public void packagedMathFontsUseBinaryMimeType() throws Exception {
        AssetManager assets = RuntimeEnvironment.getApplication().getAssets();
        String host = "https://appassets.androidplatform.net";
        String[] fonts = assets.list("web/katex/fonts");
        assertNotNull(fonts);
        assertTrue(fonts.length > 0);
        for (String font : fonts) {
            WebResourceResponse response = MainActivity.packagedUiResponse(assets, Uri.parse(host + "/katex/fonts/" + font));
            assertEquals(font, 200, response.getStatusCode());
            assertEquals("font/woff2", response.getMimeType());
            assertNull(response.getEncoding());
            try (var input = response.getData()) {
                assertArrayEquals(new byte[]{'w', 'O', 'F', '2'}, input.readNBytes(4));
            }
        }
        assertEquals(403, MainActivity.packagedUiResponse(assets, Uri.parse(host + "/katex/fonts/../katex.min.js")).getStatusCode());
    }

    @Test public void packagedUiRouteKeepsUnknownPathsAndRemoteOriginsBlocked() {
        AssetManager assets = RuntimeEnvironment.getApplication().getAssets();
        for (String url : new String[]{
                "https://appassets.androidplatform.net/other.css",
                "https://appassets.androidplatform.net/visual-system.css/extra",
                "https://appassets.androidplatform.net/../visual-system.css",
                "https://appassets.androidplatform.net/chat-web-custom.js",
                "https://appassets.androidplatform.net/live.js",
                "https://appassets.androidplatform.net/live.css",
                "https://appassets.androidplatform.net/pro-web-transport.js",
                "https://appassets.androidplatform.net/legal/LICENSE",
                "http://appassets.androidplatform.net/visual-system.css",
                "https://evil.example/visual-system.css"}) {
            assertEquals(url, 403, MainActivity.packagedUiResponse(assets, Uri.parse(url)).getStatusCode());
        }
    }

    @Test public void oldStickerPathsAreDenied() {
        var assets = RuntimeEnvironment.getApplication().getAssets();
        assertEquals(403, MainActivity.packagedUiResponse(assets, Uri.parse("https://appassets.androidplatform.net/chat-icons/01-idle.png")).getStatusCode());
    }

    @Test public void packagedLogoPassesTheWebViewRouteAndOpens() throws Exception {
        var resources = RuntimeEnvironment.getApplication().getResources();
        WebResourceResponse response = MainActivity.packagedLogoResponse(resources,
            Uri.parse("https://appassets.androidplatform.net/codex-logo.png"));
        assertEquals(200, response.getStatusCode());
        assertEquals("image/png", response.getMimeType());
        try (var body = response.getData(); var expected = resources.openRawResource(R.raw.web_logo)) {
            byte[] bytes = body.readAllBytes();
            assertArrayEquals(expected.readAllBytes(), bytes);
            assertArrayEquals("PNG header", new byte[]{(byte)137,80,78,71,13,10,26,10}, java.util.Arrays.copyOf(bytes, 8));
            if ("fresh".equals(BuildConfig.BUILD_TYPE)) {
                var portrait = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                assertEquals(192, portrait.getWidth());
                assertEquals(192, portrait.getHeight());
            }
        }
        for (String url : new String[]{
                "https://appassets.androidplatform.net/codex-logo.png/extra",
                "https://appassets.androidplatform.net/logo.png",
                "http://appassets.androidplatform.net/codex-logo.png",
                "https://evil.example/codex-logo.png"}) {
            WebResourceResponse denied = MainActivity.packagedLogoResponse(resources, Uri.parse(url));
            assertEquals(url, 403, denied.getStatusCode());
        }
    }
}
