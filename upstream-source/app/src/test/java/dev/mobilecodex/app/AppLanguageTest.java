package dev.mobilecodex.app;

import android.app.Application;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import dev.mobilecodex.app.core.Texts;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=29, application=Application.class, qualifiers="en")
public class AppLanguageTest {
    @After public void cleanup(){Texts.configure(java.util.Map.of());}
    @Test public void installedBrandAppliesToBundledStatusAndNotificationLabelsOnly() {
        var labels = java.util.Map.of("Codex 任务通知", "Codex 任务通知");
        Texts.configure(labels, "大肥龙");
        assertEquals("大肥龙任务通知", Texts.t("Codex 任务通知"));
        assertEquals("大肥龙", Texts.t("Codex CN"));
        assertEquals("Note about Codex in .codex/config.toml", Texts.t("Note about Codex in .codex/config.toml"));
        assertEquals("Android Codex 移植版 0.162.1 · Apache-2.0", Texts.t("Android Codex 移植版 0.162.1 · Apache-2.0"));
        Texts.configure(labels);
        assertEquals("Codex 任务通知", Texts.t("Codex 任务通知"));
    }
    @Test public void deviceDefaultAndExplicitChoiceAreAppliedAndPersisted()throws Exception{
        var context=RuntimeEnvironment.getApplication();AppLanguage.initialize(context);
        assertEquals("zh-CN",AppLanguage.choice(context));assertEquals("设置",Texts.t("设置"));
        AppLanguage.set(context,"system");assertEquals("Settings",Texts.t("设置"));
        assertThrows(IllegalArgumentException.class, () -> AppLanguage.set(context, "ko"));
        context.getSharedPreferences("appearance", 0).edit().putString("language", "ko").commit();
        AppLanguage.initialize(context);assertEquals("zh-CN",AppLanguage.choice(context));
        assertEquals("设置", Texts.t("设置"));
        AppLanguage.set(context,"en");assertEquals("Settings",Texts.t("设置"));assertEquals("user content",Texts.t("user content"));
        AppLanguage.set(context,"zh-CN");assertEquals("设置",Texts.t("设置"));assertEquals("设置",Texts.t("Settings"));
        AppLanguage.initialize(context);assertEquals("zh-CN",AppLanguage.choice(context));
        assertEquals("user content",Texts.t("user content"));
        assertThrows(IllegalArgumentException.class,()->AppLanguage.set(context,"unsupported"));
    }
    @Test @Config(qualifiers="ko")
    public void koreanDeviceLocaleFallsBackToSimplifiedChinese() throws Exception {
        var context = RuntimeEnvironment.getApplication();
        AppLanguage.initialize(context);
        AppLanguage.set(context, "system");
        assertEquals("ko", context.getResources().getConfiguration().getLocales().get(0).getLanguage());
        assertEquals(java.util.Locale.SIMPLIFIED_CHINESE, AppLanguage.locale(context));
        assertEquals("设置", Texts.t("设置"));
    }
}
