package io.github.kingcreeper531.ytmusic;

import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Methods the page script can call as window.TBAndroid.*. Called on a WebView background thread. */
final class Bridge {
    private final MainActivity activity;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    Bridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public void onState(String json) {
        try {
            JSONObject o = new JSONObject(json);
            NowPlaying np = new NowPlaying();
            np.videoId = o.optString("videoId");
            np.title = o.optString("title");
            np.artist = o.optString("artist");
            np.album = o.optString("album");
            np.artwork = o.optString("artwork");
            np.positionMs = (long) (o.optDouble("position", 0) * 1000);
            np.durationMs = (long) (o.optDouble("duration", 0) * 1000);
            np.playing = o.optBoolean("playing");
            activity.runOnUiThread(() -> PlaybackService.update(activity, np));
        } catch (Exception ignored) { }
    }

    @JavascriptInterface
    public void requestSegments(String videoId) {
        if (videoId == null || !videoId.matches("[\\w-]{11}")) return;
        io.execute(() -> {
            String list = "[]";
            try {
                String cats = URLEncoder.encode("[\"music_offtopic\"]", "UTF-8");
                HttpURLConnection c = (HttpURLConnection) new URL(
                        "https://sponsor.ajay.app/api/skipSegments?videoID=" + videoId + "&categories=" + cats).openConnection();
                c.setConnectTimeout(5000);
                c.setReadTimeout(5000);
                if (c.getResponseCode() == 200) {
                    JSONArray in = new JSONArray(read(c.getInputStream()));
                    JSONArray out = new JSONArray();
                    for (int i = 0; i < in.length(); i++) {
                        JSONArray seg = in.getJSONObject(i).getJSONArray("segment");
                        out.put(new JSONObject().put("start", seg.getDouble(0)).put("end", seg.getDouble(1)));
                    }
                    list = out.toString();
                }
                c.disconnect();
            } catch (Exception ignored) { /* no segments or offline */ }
            activity.evaluate("window.__tbSegments && window.__tbSegments('" + videoId + "'," + list + ")");
        });
    }

    @JavascriptInterface
    public void installUpdate() {
        activity.runOnUiThread(() -> activity.updater.install());
    }

    @JavascriptInterface
    public String updateState() {
        return activity.updater.stateJson();
    }

    static String read(InputStream in) throws Exception {
        try (InputStream s = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = s.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
