package dev.mobilecodex.app.core;

import static dev.mobilecodex.app.core.Texts.t;
/** Revocable, process-local consent. Old queued work cannot run after stop/re-enable. */
public final class PhoneControlGate {
    private boolean enabled;
    private long generation;
    public synchronized void enable() { generation++; enabled = true; }
    public synchronized void stop() { enabled = false; generation++; }
    public synchronized boolean enabled() { return enabled; }
    public synchronized long ticket() {
        if (!enabled) throw new IllegalStateException(t("手机控制未开启，请自行在“设置 → 工具”中启用。"));
        return generation;
    }
    public synchronized void check(long ticket) {
        if (!enabled || ticket != generation) throw new IllegalStateException(t("手机控制已停止，之前的请求已取消。"));
    }
}
