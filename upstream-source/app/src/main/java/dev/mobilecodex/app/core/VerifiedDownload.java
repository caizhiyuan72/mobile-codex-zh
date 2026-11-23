package dev.mobilecodex.app.core;

import static dev.mobilecodex.app.core.Texts.t;
import java.io.*;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.function.*;

public final class VerifiedDownload {
    private VerifiedDownload() {}
    public static long copy(InputStream input, OutputStream output, long size, String sha256, BooleanSupplier cancelled, LongConsumer progress) throws Exception {
        if(size<=0 || !sha256.matches("[a-f0-9]{64}"))throw new IOException(t("下载校验信息无效。"));
        MessageDigest hash=MessageDigest.getInstance("SHA-256");byte[] block=new byte[65536];long count=0;int n;
        while(true){
            if(cancelled.getAsBoolean())throw new IOException(t("已取消"));
            n=input.read(block);if(n==-1)break;
            count+=n;if(count>size)throw new IOException(t("APK 超过标注的大小。"));
            hash.update(block,0,n);output.write(block,0,n);progress.accept(count);
        }
        StringBuilder actual=new StringBuilder();for(byte b:hash.digest())actual.append(String.format(Locale.ROOT,"%02x",b&255));
        if(count!=size || !actual.toString().equals(sha256))throw new IOException(t("APK 下载校验失败，请重新下载。"));
        return count;
    }
}
