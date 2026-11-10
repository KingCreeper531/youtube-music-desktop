package io.github.kingcreeper531.ytmusic;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

public class MainActivity extends Activity {
    static final String HOME = "https://music.youtube.com/";
    private static WeakReference<MainActivity> current = new WeakReference<>(null);

    WebView web;
    Updater updater;
    private String injectJs;
    private boolean documentStartScript;

    static MainActivity get() { return current.get(); }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        current = new WeakReference<>(this);

        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
        web = new BackgroundWebView(this);
        web.setBackgroundColor(0xFF030303);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(cleanUserAgent(s.getUserAgentString()));

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);

        // Don't announce "this is an app's WebView" to Google.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
            WebSettingsCompat.setRequestedWithHeaderOriginAllowList(s, Collections.emptySet());
        }

        updater = new Updater(this, () -> runOnUiThread(this::pushUpdateState));
        web.addJavascriptInterface(new Bridge(this), "TBAndroid");

        injectJs = readAsset("inject.js");
        documentStartScript = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
        if (documentStartScript) {
            WebViewCompat.addDocumentStartJavaScript(web, injectJs, Collections.singleton("https://music.youtube.com"));
        }

        web.setWebViewClient(new Client());
        web.setWebChromeClient(new WebChromeClient());

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(HOME);

        updater.start();
    }

    // Strip the "; wv" / "Version/4.0" markers so the page sees regular Chrome for Android.
    static String cleanUserAgent(String ua) {
        return ua.replace("; wv)", ")").replaceAll("Version/\\d+(\\.\\d+)* ", "");
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            return "";
        }
    }

    /** Runs a player command inside the page (play, pause, next, previous, seek). */
    void control(String action, double arg) {
        runOnUiThread(() -> web.evaluateJavascript(
                "window.__tbControl && window.__tbControl('" + action + "'," + arg + ")", null));
    }

    void evaluate(String js) {
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }

    void pushUpdateState() {
        web.evaluateJavascript("window.__tbUpdate && window.__tbUpdate(" + updater.stateJson() + ")", null);
    }

    @Override
    protected void onResume() {
        super.onResume();
        updater.onResume();
    }

    // Deliberately no web.onPause(): music keeps playing in the background.

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true); // keep playing instead of closing
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        PlaybackService.stop(this);
        updater.stop();
        web.destroy();
        super.onDestroy();
    }

    private static boolean isInternal(Uri uri) {
        String h = uri.getHost();
        if (h == null) return false;
        return h.equals("music.youtube.com") || h.endsWith(".youtube.com") || h.equals("youtube.com")
                || h.endsWith(".google.com") || h.equals("google.com") || h.endsWith(".gstatic.com")
                || h.endsWith(".googleusercontent.com") || h.matches("accounts\\.google\\.[a-z.]+");
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri uri = req.getUrl();
            String scheme = uri.getScheme();
            if (("https".equals(scheme) || "http".equals(scheme)) && isInternal(uri)) {
                // Signed in on youtube.com home? Go back to Music.
                if ("www.youtube.com".equals(uri.getHost()) && ("/".equals(uri.getPath()) || uri.getPath() == null)) {
                    view.loadUrl(HOME);
                    return true;
                }
                return false;
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception ignored) { }
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            if (AdFilter.isBlocked(req.getUrl())) {
                return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
            }
            return null;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            // Older WebViews without document-start scripts: inject as early as we can.
            if (!documentStartScript && url != null && url.startsWith("https://music.youtube.com")) {
                view.evaluateJavascript(injectJs, null);
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pushUpdateState();
        }
    }
}
