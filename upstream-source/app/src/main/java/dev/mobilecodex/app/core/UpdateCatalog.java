package dev.mobilecodex.app.core;

import static dev.mobilecodex.app.core.Texts.t;
import org.json.*;
import java.io.IOException;
import java.net.URI;
import java.util.*;
import java.util.regex.*;
import static dev.mobilecodex.app.core.Json.*;

/** Public GitHub release metadata. Downloaded APK identity is independently checked before installation. */
public final class UpdateCatalog {
    private static final Pattern VERSION = Pattern.compile("^(\\d{1,9})\\.(\\d{1,9})\\.(\\d{1,9})(?:-(alpha|beta|rc|cn)(?:[.-]?(\\d{1,9}))?)?(?:\\+[A-Za-z0-9.-]+)?$");
    private static final Pattern APK = Pattern.compile("^mobile-codex-(.+)-arm64\\.apk$");
    public static String repository(String value) throws IOException {
        String repo = value.trim();
        if (!repo.matches("[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}") || repo.endsWith("/.") || repo.endsWith("/..")) throw new IOException(t("请按“所有者/仓库名”格式输入 GitHub 仓库。"));
        return repo;
    }
    private static long[] version(String value) throws IOException {
        Matcher m = VERSION.matcher(value);
        if (!m.matches()) throw new IOException(t("不支持的版本格式：") + value);
        // cn.N identifies a stable fork revision after the upstream base release.
        if ("cn".equals(m.group(4)) && m.group(5) == null) throw new IOException(t("不支持的版本格式：") + value);
        int rank = m.group(4) == null ? 3 : "cn".equals(m.group(4)) ? 4 : List.of("alpha", "beta", "rc").indexOf(m.group(4));
        return new long[]{Long.parseLong(m.group(1)), Long.parseLong(m.group(2)), Long.parseLong(m.group(3)), rank, m.group(5) == null ? 0 : Long.parseLong(m.group(5))};
    }
    public static int compare(String left, String right) throws IOException {
        long[] a = version(left), b = version(right);
        for (int i=0;i<a.length;i++) { int result=Long.compare(a[i],b[i]); if(result!=0)return result; }
        return 0;
    }
    public static JSONObject latest(JSONArray releases, String repo, boolean prereleases) throws Exception {
        repository(repo); JSONObject best = null;
        for (int i=0;i<releases.length();i++) {
            JSONObject release=releases.getJSONObject(i);
            if(release.optBoolean("draft") || (!prereleases && release.optBoolean("prerelease")))continue;
            JSONArray assets=release.optJSONArray("assets"); if(assets==null)continue;
            for(int j=0;j<assets.length();j++) {
                JSONObject asset=assets.getJSONObject(j);String name=asset.optString("name");Matcher m=APK.matcher(name);if(!m.matches())continue;
                String v=m.group(1);try{version(v);}catch(IOException unsupported){continue;}
                if(!prereleases && version(v)[3]<3)continue;
                String digest=asset.optString("digest");long size=asset.optLong("size");
                if(!digest.matches("sha256:[a-fA-F0-9]{64}") || size<=0 || size>2147483647L || !asset.optString("state").equals("uploaded"))continue;
                String url=asset.getString("browser_download_url");URI uri=new URI(url);
                String prefix="/"+repo+"/releases/download/";
                if(!"https".equals(uri.getScheme()) || !"github.com".equals(uri.getHost()) || uri.getPort()!=-1 || uri.getUserInfo()!=null || uri.getFragment()!=null || uri.getQuery()!=null || !uri.getPath().toLowerCase(Locale.ROOT).startsWith(prefix.toLowerCase(Locale.ROOT)) || !uri.getPath().endsWith("/"+name) || Arrays.asList(uri.getPath().split("/")).contains(".."))continue;
                if(best==null || compare(v,best.getString("versionName"))>0) {
                    String notes=release.optString("body");if(notes.length()>12000)notes=notes.substring(0,12000)+"\n…";
                    best=obj("versionName",v,"name",name,"url",url,"size",size,"sha256",digest.substring(7).toLowerCase(Locale.ROOT),"tag",release.optString("tag_name"),"notes",notes,"repository",repo);
                }
            }
        }
        return best;
    }
    public static boolean compatibleSigners(Set<String> installed, Set<String> candidate, Set<String> candidateHistory) {
        if(installed.isEmpty() || candidate.isEmpty())return false;
        if(installed.equals(candidate))return true;
        return installed.size()==1 && candidate.size()==1 && candidateHistory.containsAll(installed);
    }
    public static void identity(String expectedPackage, long installedVersion, String actualPackage, long actualVersion, String expectedName, String actualName, int minSdk, int deviceSdk, boolean signersMatch) throws IOException {
        if(!expectedPackage.equals(actualPackage))throw new IOException(t("此 APK 属于其他应用，现有应用未被修改。"));
        if(actualVersion<=installedVersion)throw new IOException(t("此 APK 不比已安装版本新。"));
        if(!expectedName.equals(actualName))throw new IOException(t("发行版版本号与 APK 版本号不一致。"));
        if(minSdk>deviceSdk)throw new IOException(t("此更新要求 Android API ")+minSdk+t(" 或更高版本。"));
        if(!signersMatch)throw new IOException(t("签名密钥与已安装应用不同。要保留数据，请使用原始签名密钥构建的 APK，不要卸载现有应用。"));
    }
}
