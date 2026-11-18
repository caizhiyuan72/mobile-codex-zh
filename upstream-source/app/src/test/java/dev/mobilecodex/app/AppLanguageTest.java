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
    @After public void cleanup(){Texts.configure(true,java.util.Map.of());}
    @Test public void installedBrandAppliesToBundledStatusAndNotificationLabelsOnly() {
        var labels = java.util.Map.of("Codex 작업 알림", "Codex 任务通知");
        Texts.configure(false, labels, "大肥龙");
        assertEquals("大肥龙任务通知", Texts.t("Codex 작업 알림"));
        assertEquals("大肥龙", Texts.t("Codex CN"));
        assertEquals("Note about Codex in .codex/config.toml", Texts.t("Note about Codex in .codex/config.toml"));
        Texts.configure(false, labels);
        assertEquals("Codex 任务通知", Texts.t("Codex 작업 알림"));
    }
    @Test public void deviceDefaultAndExplicitChoiceAreAppliedAndPersisted()throws Exception{
        var context=RuntimeEnvironment.getApplication();AppLanguage.initialize(context);
        assertEquals("zh-CN",AppLanguage.choice(context));assertEquals("设置",Texts.t("설정"));
        AppLanguage.set(context,"system");assertEquals("Settings",Texts.t("설정"));
        AppLanguage.set(context,"ko");assertEquals("설정",Texts.t("설정"));
        AppLanguage.initialize(context);assertEquals("ko",AppLanguage.choice(context));
        AppLanguage.set(context,"en");assertEquals("Settings",Texts.t("설정"));assertEquals("user content",Texts.t("user content"));
        AppLanguage.set(context,"zh-CN");assertEquals("设置",Texts.t("설정"));assertEquals("设置",Texts.t("Settings"));
        AppLanguage.initialize(context);assertEquals("zh-CN",AppLanguage.choice(context));
        assertEquals("user content",Texts.t("user content"));
        assertThrows(IllegalArgumentException.class,()->AppLanguage.set(context,"unsupported"));
    }
}
