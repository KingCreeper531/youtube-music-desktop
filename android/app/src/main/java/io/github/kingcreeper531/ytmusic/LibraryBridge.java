package io.github.kingcreeper531.ytmusic;

import android.webkit.JavascriptInterface;

import org.json.JSONObject;

/** window.TBLibrary for the My Music page (a local page, never remote content). */
final class LibraryBridge {
    private final MainActivity activity;

    LibraryBridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public String list() {
        return activity.library.listJson();
    }

    @JavascriptInterface
    public void add() {
        activity.runOnUiThread(activity::pickAudio);
    }

    @JavascriptInterface
    public void remove(String id) {
        activity.library.remove(id);
    }

    @JavascriptInterface
    public void back() {
        activity.runOnUiThread(activity::showYouTubeMusic);
    }

    @JavascriptInterface
    public void onState(String json) {
        NowPlaying np = null;
        try {
            if (json != null && !"null".equals(json)) {
                JSONObject o = new JSONObject(json);
                np = new NowPlaying();
                np.title = o.optString("title");
                np.artist = o.optString("artist");
                np.album = o.optString("album");
                np.artwork = o.optString("art");
                np.positionMs = (long) (o.optDouble("currentTime", 0) * 1000);
                np.durationMs = (long) (o.optDouble("duration", 0) * 1000);
                np.playing = !o.optBoolean("paused", true);
            }
        } catch (Exception ignored) { }
        final NowPlaying state = np;
        activity.runOnUiThread(() -> activity.onLocalState(state));
    }
}
