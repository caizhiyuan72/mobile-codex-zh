package dev.mobilecodex.app;

import static dev.mobilecodex.app.core.Texts.t;
import android.content.*;
import android.content.pm.*;
import android.os.Build;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Supplier;
import dev.mobilecodex.app.core.UpdateCatalog;
import dev.mobilecodex.app.core.VerifiedDownload;
import static dev.mobilecodex.app.core.Json.*;

/** One app-owned operation at a time; network and APK hashing never occupy the model's work queue. */
final class AppUpdates {
    interface InstallResult { void complete(File apk, Exception error); }
    interface ReleaseSource { JSONArray read(String repository) throws Exception; }
    private static final class UpdateFailure extends IOException {
        private final int httpCode;
        UpdateFailure(String key) { this(key, 0); }
        UpdateFailure(String key, int httpCode) { super(key); this.httpCode=httpCode; }
        @Override public String getMessage() { return t(super.getMessage())+(httpCode==0?"":httpCode+")"); }
    }
    private final Context context;
    private final SharedPreferences prefs;
    private final File directory;
    private final Consumer<JSONObject> listener;
    private final ReleaseSource releases;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final AtomicBoolean cancelled=new AtomicBoolean();
    private volatile HttpURLConnection connection;
    private JSONObject candidate;
    private String status="idle";
    private Supplier<String> message=()->t("检查更新以获取公开发布的版本信息。");
    private boolean busy, ready;
    private long received, revision;
    AppUpdates(Context context, Consumer<JSONObject> listener) {
        this(context,listener,null);
    }
    AppUpdates(Context context, Consumer<JSONObject> listener, ReleaseSource releases) {
        this.context=context.getApplicationContext();this.listener=listener;prefs=context.getSharedPreferences("app-updates",0);directory=new File(context.getCacheDir(),"app-updates");
        this.releases=releases!=null?releases:repo->new JSONArray(new String(readSmall("https://api.github.com/repos/"+repo+"/releases?per_page=20"),StandardCharsets.UTF_8));
        File[] partials=directory.listFiles((dir,name)->name.endsWith(".part"));
        if(partials!=null && partials.length>0){for(File partial:partials)partial.delete();setMessage("上次下载已中断，请重新检查更新。");}
        try {
            String saved=prefs.getString("downloaded","");
            if(!saved.isEmpty()) {
                JSONObject data=parse(saved);
                if(data.optString("sha256").matches("[a-f0-9]{64}") && data.optString("repository").equals(repository()) && UpdateCatalog.compare(data.getString("versionName"),installed().versionName)>0) {
                    candidate=data;ready=apk().isFile() && apk().length()==data.getLong("size");
                    if(ready){status="ready";setMessage("已下载更新 APK，安装前将重新验证。");}
                }
            }
        } catch(Exception ignored){candidate=null;ready=false;}
    }
    private PackageInfo installed() throws PackageManager.NameNotFoundException { return context.getPackageManager().getPackageInfo(context.getPackageName(),PackageManager.GET_SIGNING_CERTIFICATES); }
    private String repository(){return prefs.getString("repository","caizhiyuan72/mobile-codex-zh");}
    private File apk(){return new File(directory,candidate.optString("sha256")+".apk");}
    synchronized JSONObject snapshot() {
        String version="";long code=0;try{PackageInfo current=installed();version=current.versionName;code=current.getLongVersionCode();}catch(Exception ignored){}
        boolean available=false;try{available=candidate!=null && UpdateCatalog.compare(candidate.getString("versionName"),version)>0;}catch(Exception ignored){}
        String[] downloads=directory.list((dir,name)->name.endsWith(".apk"));
        return obj("hasDownload",downloads!=null && downloads.length>0,"revision",revision,"available",available,"status",status,"message",message.get(),"busy",busy,"ready",ready,"received",received,"candidate",candidate==null?JSONObject.NULL:parse(candidate.toString()),"repository",repository(),"prereleases",prefs.getBoolean("prereleases",true),"versionName",version,"versionCode",code,"canInstall",context.getPackageManager().canRequestPackageInstalls(),"canCancel",busy && !status.equals("installing"));
    }
    private void setMessage(String key){message=()->t(key);}
    private synchronized void changed(){revision++;listener.accept(snapshot());}
    private void idle() throws IOException{if(busy)throw new IOException(t("更新操作正在进行，请完成或取消后重试。"));}
    synchronized void configure(String repo,boolean prereleases)throws Exception{
        idle();repo=UpdateCatalog.repository(repo);
        if(repo.equals(repository()) && prereleases==prefs.getBoolean("prereleases",true))return;
        prefs.edit().putString("repository",repo).putBoolean("prereleases",prereleases).remove("downloaded").apply();candidate=null;ready=false;status="idle";setMessage("分发设置已保存。请检查更新。");changed();
    }
    private synchronized void begin(String phase,String key)throws Exception{idle();cancelled.set(false);busy=true;status=phase;setMessage(key);received=0;changed();}
    private synchronized void failed(Exception error){
        busy=false;boolean wasCancelled=cancelled.get();status=wasCancelled?"cancelled":"error";
        if(wasCancelled)setMessage("更新操作已取消。");
        else if(error instanceof UpdateFailure failure)message=failure::getMessage;
        else {String detail=error.getMessage();setMessage(detail==null?"更新处理失败，请重试。":detail);}
        changed();
    }
    private void checkCancelled()throws IOException{if(cancelled.get())throw new IOException(t("已取消"));}
    synchronized void check()throws Exception{
        begin("checking","正在检查新版本…");ready=false;candidate=null;
        final String repo=repository();final boolean pre=prefs.getBoolean("prereleases",true);
        worker.execute(()->{try{
            JSONObject found=UpdateCatalog.latest(releases.read(repo),repo,pre);checkCancelled();
            synchronized(this){
                busy=false;candidate=found;
                if(found==null){status="unavailable";setMessage("找不到可安装的发行版，需要 ARM64 APK 和 GitHub SHA-256 元数据。");}
                else if(UpdateCatalog.compare(found.getString("versionName"),installed().versionName)<=0){status="upToDate";setMessage("当前安装版本不低于找到的公开版本。");}
                else if(apk().isFile() && apk().length()==found.getLong("size")){ready=true;status="ready";setMessage("已下载更新 APK，安装前将重新验证。");}
                else{status="available";setMessage("有新版本可下载。");}
                changed();
            }
        }catch(Exception error){failed(error);}finally{HttpURLConnection c=connection;if(c!=null)c.disconnect();connection=null;}});
    }
    private void requireCandidate(String sha256)throws IOException{if(candidate==null || !candidate.optString("sha256").equals(sha256))throw new IOException(t("更新信息已变化，请重新检查。"));}
    synchronized void download(String sha256)throws Exception{
        idle();requireCandidate(sha256);if(candidate==null || UpdateCatalog.compare(candidate.getString("versionName"),installed().versionName)<=0)throw new IOException(t("请先检查新版本。"));
        final JSONObject selected=parse(candidate.toString());begin("downloading","正在下载更新…");ready=false;
        worker.execute(()->{File partial=new File(directory,UUID.randomUUID()+".part");try{
            directory.mkdirs();long size=selected.getLong("size");if(directory.getUsableSpace()<size+32L*1024*1024)throw new UpdateFailure("下载空间不足，请清理存储空间。");
            HttpURLConnection request=open(selected.getString("url"));long announced=request.getContentLengthLong();if(announced>=0 && announced!=size)throw new UpdateFailure("APK 大小与发行信息不一致。");
            long count;long[] last={0};
            try(InputStream input=request.getInputStream();OutputStream output=new FileOutputStream(partial)){
                count=VerifiedDownload.copy(input,output,size,selected.getString("sha256"),cancelled::get,bytes->{
                    if(System.currentTimeMillis()-last[0]>=250){synchronized(this){received=bytes;changed();}last[0]=System.currentTimeMillis();}
                });
            }finally{request.disconnect();connection=null;}
            synchronized(this){status="verifying";setMessage("正在检查 APK 版本和签名…");received=count;changed();}
            verify(partial,selected);checkCancelled();File destination=new File(directory,selected.getString("sha256")+".apk");Files.move(partial.toPath(),destination.toPath(),StandardCopyOption.REPLACE_EXISTING);
            prefs.edit().putString("downloaded",selected.toString()).apply();
            synchronized(this){busy=false;ready=true;status="ready";setMessage("验证完成，点击“安装”打开 Android 确认界面。");changed();}
        }catch(Exception error){failed(error);}finally{partial.delete();HttpURLConnection c=connection;if(c!=null)c.disconnect();connection=null;}});
    }
    synchronized void cancel(){if(busy && !status.equals("installing")){cancelled.set(true);HttpURLConnection c=connection;if(c!=null)c.disconnect();setMessage("正在取消…");changed();}}
    synchronized void clear()throws Exception{
        idle();File[] files=directory.listFiles();if(files!=null)for(File file:files)if(file.getName().matches("[a-f0-9-]+\\.(apk|part)")&&!file.delete())throw new IOException(t("无法删除已下载的文件。"));
        prefs.edit().remove("downloaded").apply();ready=false;status=candidate==null?"idle":"available";setMessage("已删除下载的更新。");changed();
    }
    synchronized void prepareInstall(String sha256,InstallResult result)throws Exception{
        idle();requireCandidate(sha256);if(!ready||candidate==null)throw new IOException(t("请先下载 APK。"));
        final JSONObject selected=parse(candidate.toString());final File file=apk();begin("verifying","安装前正在重新验证 APK…");
        worker.execute(()->{try{
            if(!file.isFile()||file.length()!=selected.getLong("size"))throw new UpdateFailure("找不到已下载的 APK，请重新下载。");
            try(InputStream input=new FileInputStream(file)){
                VerifiedDownload.copy(input,new OutputStream(){public void write(int value){} public void write(byte[] bytes,int offset,int length){}},selected.getLong("size"),selected.getString("sha256"),cancelled::get,bytes->{});
            }
            verify(file,selected);checkCancelled();synchronized(this){status="installing";setMessage("请在 Android 安装程序中确认。");changed();}result.complete(file,null);
        }catch(Exception error){synchronized(this){ready=false;}failed(error);result.complete(null,error);}});
    }
    synchronized void installEnded(){if(status.equals("installing")){busy=false;status="ready";setMessage("安装程序已关闭，请检查当前应用版本。");changed();}}
    private void verify(File file,JSONObject selected)throws Exception{
        PackageManager manager=context.getPackageManager();PackageInfo current=installed(),next=manager.getPackageArchiveInfo(file.getAbsolutePath(),PackageManager.GET_SIGNING_CERTIFICATES);
        if(next==null||next.applicationInfo==null||next.signingInfo==null||current.signingInfo==null)throw new UpdateFailure("无法读取 APK 包名或签名信息。");
        Set<String> history=next.signingInfo.hasMultipleSigners()?Set.of():certificates(next.signingInfo.getSigningCertificateHistory());
        UpdateCatalog.identity(context.getPackageName(),current.getLongVersionCode(),next.packageName,next.getLongVersionCode(),selected.getString("versionName"),next.versionName,next.applicationInfo.minSdkVersion,Build.VERSION.SDK_INT,UpdateCatalog.compatibleSigners(certificates(current.signingInfo.getApkContentsSigners()),certificates(next.signingInfo.getApkContentsSigners()),history));
    }
    private static Set<String> certificates(Signature[] signatures)throws Exception{Set<String> result=new HashSet<>();if(signatures!=null)for(Signature signature:signatures)result.add(hex(MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())));return result;}
    private static String hex(byte[] bytes){StringBuilder out=new StringBuilder();for(byte b:bytes)out.append(String.format(Locale.ROOT,"%02x",b&255));return out.toString();}
    private byte[] readSmall(String url)throws Exception{
        HttpURLConnection request=open(url);try(InputStream input=request.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){
            byte[] block=new byte[8192];int n;while((n=input.read(block))!=-1){checkCancelled();if(out.size()+n>2*1024*1024)throw new UpdateFailure("发行版响应过大。");out.write(block,0,n);}return out.toByteArray();
        }finally{request.disconnect();connection=null;}
    }
    private HttpURLConnection open(String raw)throws Exception{
        URL url=new URL(raw);
        for(int redirect=0;redirect<6;redirect++){
            checkCancelled();validateHost(url);
            HttpURLConnection request=(HttpURLConnection)url.openConnection();connection=request;request.setInstanceFollowRedirects(false);request.setConnectTimeout(15000);request.setReadTimeout(30000);request.setRequestProperty("User-Agent","Mobile-Codex-Android-Updater");request.setRequestProperty("Accept",url.getHost().equals("api.github.com")?"application/vnd.github+json":"application/octet-stream");
            int code=request.getResponseCode();
            if(code>=300&&code<400){String location=request.getHeaderField("Location");request.disconnect();if(location==null)throw new UpdateFailure("下载跳转响应无效。");url=new URL(url,location);continue;}
            if(code!=200){request.disconnect();throw httpFailure(code);}
            return request;
        }
        throw new UpdateFailure("下载跳转次数过多。");
    }
    static IOException httpFailure(int code){
        if(code==403||code==429)return new UpdateFailure("已达到 GitHub 请求频率限制或访问被拒绝，请稍后重试。");
        if(code==404)return new UpdateFailure("找不到公开仓库或发行版资源。");
        return new UpdateFailure("更新服务器错误（",code);
    }
    static void validateHost(URL url)throws IOException{
        if(!url.getProtocol().equals("https")||url.getUserInfo()!=null||(url.getPort()!=-1&&url.getPort()!=443)||!Set.of("api.github.com","github.com","release-assets.githubusercontent.com","objects.githubusercontent.com","github-releases.githubusercontent.com").contains(url.getHost()))throw new UpdateFailure("不允许使用此更新链接。");
    }
    void shutdown(){cancel();worker.shutdownNow();}
}
