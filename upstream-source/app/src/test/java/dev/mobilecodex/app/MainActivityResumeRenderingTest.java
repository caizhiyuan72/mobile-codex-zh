package dev.mobilecodex.app;

import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.webkit.WebView;
import android.widget.FrameLayout;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 29, application = MobileCodexApp.class)
public class MainActivityResumeRenderingTest {
    private static SafeWebViewLayout root(MainActivity activity) {
        FrameLayout content = activity.findViewById(android.R.id.content);
        return (SafeWebViewLayout) content.getChildAt(0);
    }

    private static ColorDrawable windowBackground(MainActivity activity) {
        return (ColorDrawable) shadowOf(activity.getWindow()).getBackgroundDrawable();
    }

    private static void assertBackgrounds(MainActivity activity, int background) {
        SafeWebViewLayout root = root(activity);
        assertEquals(background, windowBackground(activity).getColor());
        assertEquals(background, ((ColorDrawable) root.getBackground()).getColor());
        assertEquals(background, shadowOf((WebView) root.getChildAt(0)).getBackgroundColor());
    }

    @Test public void savedClassicLightThemeColorsAllSurfacesBeforePageFinishes() {
        try (var controller = Robolectric.buildActivity(MainActivity.class)) {
            MainActivity activity = controller.get();
            activity.getPreferences(Context.MODE_PRIVATE).edit().putString("theme", "light").apply();
            controller.create();

            assertBackgrounds(activity, Color.rgb(250, 250, 250));
        }
    }

    @Test public void comingBackKeepsTheLoadedWebViewAndGlassPalette() throws Exception {
        try (var controller = Robolectric.buildActivity(MainActivity.class)) {
            MainActivity activity = controller.get();
            activity.getPreferences(Context.MODE_PRIVATE).edit().putString("theme", "dark").putBoolean("liquidGlass", true).apply();
            activity.getSharedPreferences("notifications", 0).edit().putBoolean("enabled", false).apply();
            AppTextSize.set(activity, 130);
            controller.create().start().resume();

            int background = Color.rgb(43, 63, 96);
            assertBackgrounds(activity, background);
            var windowBackground = windowBackground(activity);
            WebView web = (WebView) root(activity).getChildAt(0);
            var shadowWeb = shadowOf(web);
            String url = shadowWeb.getLastLoadedUrl();
            shadowWeb.getWebViewClient().onPageFinished(web, url);
            assertEquals(130, web.getSettings().getTextZoom());

            controller.pause().stop();
            activity.onConfigurationChanged(new Configuration(activity.getResources().getConfiguration()));
            controller.restart().start().resume();

            assertSame(web, root(activity).getChildAt(0));
            assertSame(windowBackground, windowBackground(activity));
            assertEquals(url, shadowWeb.getLastLoadedUrl());
            assertEquals(0, shadowWeb.getReloadInvocations());
            assertEquals(130, web.getSettings().getTextZoom());
            assertBackgrounds(activity, background);
        }
    }
}
