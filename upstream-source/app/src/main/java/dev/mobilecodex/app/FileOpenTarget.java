package dev.mobilecodex.app;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.webkit.MimeTypeMap;
import java.util.Locale;

record FileOpenTarget(Uri uri, String name, String mime) {
    static final String PDF = "application/pdf";
    static final String DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    static final String APK = "application/vnd.android.package-archive";
    static final String UNKNOWN = "application/octet-stream";

    static String mimeFor(String name, String providerMime) {
        String extension = name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        return switch (extension) {
            case "pdf" -> PDF;
            case "docx" -> DOCX;
            case "doc" -> "application/msword";
            case "apk" -> APK;
            default -> {
                if (providerMime != null && !providerMime.isBlank() && !UNKNOWN.equals(providerMime) && !providerMime.contains("*"))
                    yield providerMime;
                String mime = name.contains(".") ? MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) : null;
                yield mime != null ? mime : UNKNOWN;
            }
        };
    }

    static boolean prefersViewer(String mime) {
        return PDF.equals(mime) || DOCX.equals(mime) || APK.equals(mime) || "application/msword".equals(mime)
            || mime.startsWith("application/vnd.openxmlformats-officedocument.");
    }

    boolean hasInternalPreview() { return PDF.equals(mime) || DOCX.equals(mime); }

    Intent viewIntent() {
        Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.setClipData(ClipData.newRawUri(name, uri));
        return intent;
    }
}
