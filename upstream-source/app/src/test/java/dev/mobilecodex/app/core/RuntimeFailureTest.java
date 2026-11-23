package dev.mobilecodex.app.core;

import static org.junit.Assert.*;
import org.junit.Test;

public class RuntimeFailureTest {
    @Test public void onlyKnownStderrPatternsProduceSafeLabels() {
        assertEquals("", RuntimeFailure.classify("oauth token=definitely-not-a-real-token"));
        assertEquals("原生依赖错误", RuntimeFailure.classify("CANNOT LINK EXECUTABLE: cannot locate symbol"));
        assertEquals("内部运行时错误", RuntimeFailure.classify("thread 'main' panicked at runtime"));
        assertEquals("内存不足", RuntimeFailure.classify("memory allocation failed"));
        assertEquals("配置格式错误", RuntimeFailure.classify("failed to parse config.toml"));
    }
    @Test public void tailRetainsOnlyTheLastBoundedBytes() {
        RuntimeFailure.Tail tail = new RuntimeFailure.Tail();
        tail.append(new byte[RuntimeFailure.MAX_TAIL_BYTES + 32], RuntimeFailure.MAX_TAIL_BYTES + 32);
        assertEquals(RuntimeFailure.MAX_TAIL_BYTES, tail.bufferedBytesForTest());
        assertEquals("", tail.diagnosis());
    }
}
