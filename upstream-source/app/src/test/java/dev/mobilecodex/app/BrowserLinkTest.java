package dev.mobilecodex.app;

import android.app.Application;
import android.net.Uri;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 29, application = Application.class)
public class BrowserLinkTest {
    @Test public void gitHubAuthorizationUsesOnlyTheFixedBrowserRoutes() {
        assertEquals("https://github.com/settings/applications/new", MainActivity.githubBrowserUri(true, "").toString());
        assertEquals("https://github.com/login/device", MainActivity.githubBrowserUri(false, "https://github.com/login/device").toString());
        for (String value : new String[]{"https://github.com.attacker.test/login/device", "http://github.com/login/device", "https://github.com:443/login/device", "https://user@github.com/login/device", "https://github.com/login/device?code=secret", "https://github.com/login/device#fragment", ""}) {
            try { MainActivity.githubBrowserUri(false, value); fail(value); }
            catch (IllegalArgumentException expected) { }
        }
    }
    @Test public void messageLinksAllowHttpWithoutWeakeningAccountFlows() {
        assertTrue(MainActivity.isBrowserUri(Uri.parse("http://example.com/docs"), true));
        assertTrue(MainActivity.isBrowserUri(Uri.parse("https://example.com/docs"), true));
        assertTrue(MainActivity.isBrowserUri(Uri.parse("https://example.com/oauth"), false));
        assertFalse(MainActivity.isBrowserUri(Uri.parse("http://example.com/oauth"), false));
    }
    @Test public void neitherRouteAcceptsCredentialsFilesOrExecutableSchemes() {
        for (String url : new String[]{"javascript:alert(1)", "file:///private/auth.json", "content://provider/file", "intent://example.com", "https://user:pass@example.com", "https:///", "/relative"}) {
            assertFalse(url, MainActivity.isBrowserUri(Uri.parse(url), true));
            assertFalse(url, MainActivity.isBrowserUri(Uri.parse(url), false));
        }
    }
}
