package dev.mobilecodex.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.text.TextUtils;
import android.view.Gravity;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipFile;

public final class DocumentPreviewActivity extends Activity {
    private static final String ORIGIN = "https://document-preview.invalid";
    private static final int DOCX_LIMIT = 24 * 1024 * 1024;
    private static final int PDF_COPY_LIMIT = 256 * 1024 * 1024;
    private static final long ZIP_EXPANDED_LIMIT = 64L * 1024 * 1024;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private FileOpenTarget target;
    private LinearLayout root;
    private TextView status;
    private WebView web;
    private PdfRenderer pdf;
    private File cachedPdf;
    private File cachedDocx;
    private int page, pageCount;
    private Button previous, next;
    private ImageView pdfImage;
    private ScrollView pdfScroll;

    static Context localized(Context context) {
        var config = new android.content.res.Configuration(context.getResources().getConfiguration());
        config.setLocale(AppLanguage.locale(context));
        return context.createConfigurationContext(config);
    }

    @Override protected void attachBaseContext(Context base) { super.attachBaseContext(localized(base)); }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        Intent intent = getIntent();
        if (intent.getData() == null || !"content".equals(intent.getData().getScheme())) { finish(); return; }
        target = new FileOpenTarget(intent.getData(), intent.getStringExtra(Intent.EXTRA_TITLE), intent.getType());
        if (!target.hasInternalPreview()) { finish(); return; }

        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(250, 250, 250));
        setContentView(root);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            var bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
        LinearLayout heading = new LinearLayout(this);
        heading.setGravity(Gravity.CENTER_VERTICAL);
        heading.addView(button(R.string.file_preview_back, this::finish));
        TextView title = new TextView(this);
        title.setText(target.name());
        title.setSingleLine(true);
        title.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        heading.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        heading.addView(button(R.string.file_open_with, this::openExternally));
        root.addView(heading);
        status = new TextView(this);
        status.setGravity(Gravity.CENTER);
        status.setText(R.string.file_preview_loading);
        root.addView(status);
        if (FileOpenTarget.PDF.equals(target.mime())) initPdf(state == null ? 0 : state.getInt("page"));
        else initDocx();
    }

    private Button button(int label, Runnable action) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(label);
        button.setOnClickListener(view -> action.run());
        return button;
    }

    private void openExternally() {
        try { startActivity(Intent.createChooser(target.viewIntent(), getString(R.string.file_open_with))); }
        catch (ActivityNotFoundException | SecurityException error) { status.setText(R.string.file_no_viewer); }
    }

    private void initPdf(int initialPage) {
        LinearLayout navigation = new LinearLayout(this);
        navigation.setGravity(Gravity.CENTER);
        previous = button(R.string.file_preview_previous, () -> renderPdf(page - 1));
        next = button(R.string.file_preview_next, () -> renderPdf(page + 1));
        previous.setEnabled(false);
        next.setEnabled(false);
        navigation.addView(previous);
        navigation.addView(next);
        root.addView(navigation);

        pdfScroll = new ScrollView(this);
        pdfImage = new ImageView(this);
        pdfImage.setAdjustViewBounds(true);
        pdfScroll.addView(pdfImage, new ScrollView.LayoutParams(-1, -2));
        root.addView(pdfScroll, new LinearLayout.LayoutParams(-1, 0, 1));
        worker.execute(() -> {
            try {
                ParcelFileDescriptor descriptor = openPdfDescriptor();
                try { pdf = new PdfRenderer(descriptor); }
                catch (Exception error) { descriptor.close(); throw error; }
                int count = pdf.getPageCount();
                if (count < 1) throw new IOException();
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    pageCount = count;
                    renderPdf(Math.min(initialPage, count - 1));
                });
            } catch (Exception error) { showError(); }
        });
    }

    private ParcelFileDescriptor openPdfDescriptor() throws IOException {
        ParcelFileDescriptor descriptor = getContentResolver().openFileDescriptor(target.uri(), "r");
        if (descriptor == null) throw new IOException();
        try {
            Os.lseek(descriptor.getFileDescriptor(), 0, OsConstants.SEEK_SET);
            return descriptor;
        } catch (ErrnoException nonSeekable) {
            descriptor.close();
            cachedPdf = copyToCache(PDF_COPY_LIMIT);
            return ParcelFileDescriptor.open(cachedPdf, ParcelFileDescriptor.MODE_READ_ONLY);
        }
    }

    private void renderPdf(int index) {
        if (index < 0 || index >= pageCount) return;
        previous.setEnabled(false);
        next.setEnabled(false);
        status.setText(R.string.file_preview_loading);
        int targetWidth = Math.min(1800, getResources().getDisplayMetrics().widthPixels);
        worker.execute(() -> {
            try (PdfRenderer.Page pdfPage = pdf.openPage(index)) {
                double scale = Math.min((double) targetWidth / pdfPage.getWidth(), 3200.0 / pdfPage.getHeight());
                int width = Math.max(1, (int) (pdfPage.getWidth() * scale));
                int height = Math.max(1, (int) (pdfPage.getHeight() * scale));
                Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
                bitmap.eraseColor(Color.WHITE);
                pdfPage.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                runOnUiThread(() -> {
                    if (isDestroyed()) { bitmap.recycle(); return; }
                    page = index;
                    pdfImage.setImageBitmap(bitmap);
                    pdfScroll.scrollTo(0, 0);
                    status.setText(getString(R.string.file_preview_page, page + 1, pageCount));
                    previous.setEnabled(page > 0);
                    next.setEnabled(page + 1 < pageCount);
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    status.setText(R.string.file_preview_failed);
                    previous.setEnabled(page > 0);
                    next.setEnabled(page + 1 < pageCount);
                });
            }
        });
    }

    private File copyToCache(long limit) throws IOException {
        File copy = File.createTempFile("document-preview-", ".tmp", getCacheDir());
        boolean complete = false;
        try (InputStream input = getContentResolver().openInputStream(target.uri()); var out = Files.newOutputStream(copy.toPath())) {
            if (input == null) throw new IOException();
            byte[] buffer = new byte[64 * 1024];
            long size = 0;
            for (int count; (count = input.read(buffer)) != -1;) {
                size += count;
                if (size > limit) throw new IOException();
                out.write(buffer, 0, count);
            }
            complete = true;
            return copy;
        } finally { if (!complete) Files.deleteIfExists(copy.toPath()); }
    }

    static void validateDocx(File file) throws IOException {
        try (ZipFile zip = new ZipFile(file)) {
            if (zip.size() > 2000 || zip.getEntry("word/document.xml") == null || zip.getEntry("[Content_Types].xml") == null)
                throw new IOException();
            var entries = zip.entries();
            long total = 0;
            byte[] buffer = new byte[16 * 1024];
            while (entries.hasMoreElements()) {
                var entry = entries.nextElement();
                if (entry.isDirectory()) continue;
                if (entry.getSize() > ZIP_EXPANDED_LIMIT - total) throw new IOException();
                try (InputStream input = zip.getInputStream(entry)) {
                    for (int count; (count = input.read(buffer)) != -1;) {
                        total += count;
                        if (total > ZIP_EXPANDED_LIMIT) throw new IOException();
                    }
                }
            }
        }
    }

    private void initDocx() {
        worker.execute(() -> {
            try {
                cachedDocx = copyToCache(DOCX_LIMIT);
                validateDocx(cachedDocx);
                File file = cachedDocx;
                runOnUiThread(() -> { if (!isDestroyed()) showDocx(file); });
            } catch (Exception error) { showError(); }
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void showDocx(File docx) {
        web = new WebView(this);
        var settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                try {
                    return switch (request.getUrl().toString()) {
                        case ORIGIN + "/" -> asset("index.html", "text/html");
                        case ORIGIN + "/preview.js" -> asset("preview.js", "application/javascript");
                        case ORIGIN + "/jszip.min.js" -> asset("jszip.min.js", "application/javascript");
                        case ORIGIN + "/docx-preview.min.js" -> asset("docx-preview.min.js", "application/javascript");
                        case ORIGIN + "/document" -> new WebResourceResponse(FileOpenTarget.DOCX, null, new FileInputStream(docx));
                        default -> denied();
                    };
                } catch (IOException error) { return denied(); }
            }
            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                root.removeView(view);
                view.destroy();
                web = null;
                showError();
                return true;
            }
        });
        web.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override public void onReceivedTitle(WebView view, String title) {
                if ("ready".equals(title)) status.setVisibility(android.view.View.GONE);
                if ("failed".equals(title)) showError();
            }
        });
        root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        web.loadUrl(ORIGIN + "/");
    }

    private WebResourceResponse asset(String name, String mime) throws IOException {
        return new WebResourceResponse(mime, "UTF-8", getAssets().open("document-preview/" + name));
    }

    private static WebResourceResponse denied() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Map.of(), new ByteArrayInputStream(new byte[0]));
    }

    private void showError() {
        runOnUiThread(() -> {
            if (isDestroyed()) return;
            status.setVisibility(android.view.View.VISIBLE);
            status.setText(R.string.file_preview_failed);
        });
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        state.putInt("page", page);
        super.onSaveInstanceState(state);
    }

    @Override protected void onDestroy() {
        if (web != null) { root.removeView(web); web.destroy(); }
        worker.execute(() -> {
            try { if (pdf != null) pdf.close(); }
            finally {
                if (cachedPdf != null) cachedPdf.delete();
                if (cachedDocx != null) cachedDocx.delete();
            }
        });
        worker.shutdown();
        super.onDestroy();
    }
}
