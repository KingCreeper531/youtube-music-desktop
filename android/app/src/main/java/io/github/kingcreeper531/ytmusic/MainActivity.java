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

    private static final int REQ_PICK_AUDIO = 42;

    WebView web;
    Updater updater;
    LibraryStore library;
    private android.widget.FrameLayout root;
    private BackgroundWebView libWeb;
    private boolean libraryShown;
    private final java.util.concurrent.ExecutorService io = java.util.concurrent.Executors.newSingleThreadExecutor();

    // Two sources can play: YouTube Music and My Music. Starting one pauses the other.
    private String activeSource = "ytm";
    private NowPlaying ytmNp;
    private NowPlaying localNp;

    private String injectJs;
    private boolean documentStartScript;

    static MainActivity get() { return current.get(); }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        current = new WeakReference<>(this);

        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
        library = new LibraryStore(this);
        web = new BackgroundWebView(this);
        web.setBackgroundColor(0xFF030303);
        root = new android.widget.FrameLayout(this);
        root.addView(web);
        setContentView(root);

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

    /** Runs a player command (play, pause, toggle, next, previous, seek) on whichever source is active. */
    void control(String action, double arg) {
        runOnUiThread(() -> {
            if ("local".equals(activeSource) && libWeb != null) controlLibrary(action, arg);
            else controlYouTubeMusic(action, arg);
        });
    }

    private void controlYouTubeMusic(String action, double arg) {
        web.evaluateJavascript("window.__tbControl && window.__tbControl('" + action + "'," + arg + ")", null);
    }

    private void controlLibrary(String action, double arg) {
        if (libWeb != null) libWeb.evaluateJavascript("window.__libControl && window.__libControl('" + action + "'," + arg + ")", null);
    }

    // ------------------------------------------------------------------ sources
    void onYtmState(NowPlaying np) {
        ytmNp = np;
        if (np != null && np.playing) {
            if (localNp != null && localNp.playing) controlLibrary("pause", 0);
            activeSource = "ytm";
        }
        if ("ytm".equals(activeSource) && np != null) PlaybackService.update(this, np);
    }

    void onLocalState(NowPlaying np) {
        localNp = np;
        if (np != null && np.playing) {
            if (ytmNp != null && ytmNp.playing) controlYouTubeMusic("pause", 0);
            activeSource = "local";
        }
        if (np == null) {
            if ("local".equals(activeSource)) {
                activeSource = "ytm";
                if (ytmNp != null) PlaybackService.update(this, ytmNp);
            }
            return;
        }
        if ("local".equals(activeSource)) PlaybackService.update(this, np);
    }

    // ------------------------------------------------------------------ My Music
    void openLibrary() {
        if (libWeb == null) {
            libWeb = new BackgroundWebView(this);
            libWeb.setBackgroundColor(0xFF030303);
            WebSettings ls = libWeb.getSettings();
            ls.setJavaScriptEnabled(true);
            ls.setDomStorageEnabled(true);
            ls.setAllowFileAccess(true); // play the copies stored in the app's private folder
            ls.setMediaPlaybackRequiresUserGesture(false);
            libWeb.addJavascriptInterface(new LibraryBridge(this), "TBLibrary");
            libWeb.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                    return true; // the library page never navigates anywhere
                }
            });
            root.addView(libWeb);
            libWeb.loadUrl("file:///android_asset/library.html");
        }
        libWeb.bringToFront();
        libraryShown = true;
    }

    void showYouTubeMusic() {
        web.bringToFront();
        libraryShown = false;
    }

    void pickAudio() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("audio/*")
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try {
            startActivityForResult(i, REQ_PICK_AUDIO);
        } catch (Exception ignored) { }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK_AUDIO || resultCode != RESULT_OK || data == null) return;
        java.util.List<Uri> uris = new java.util.ArrayList<>();
        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        if (uris.isEmpty()) return;
        io.execute(() -> {
            String result = library.importUris(uris);
            runOnUiThread(() -> {
                if (libWeb != null) libWeb.evaluateJavascript("window.__libRefresh && window.__libRefresh(" + result + ")", null);
            });
        });
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
        if (libraryShown) showYouTubeMusic(); // the song keeps playing
        else if (web.canGoBack()) web.goBack();
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
        io.shutdownNow();
        if (libWeb != null) libWeb.destroy();
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
