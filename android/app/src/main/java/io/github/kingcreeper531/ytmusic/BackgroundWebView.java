package io.github.kingcreeper531.ytmusic;

import android.content.Context;
import android.view.View;
import android.webkit.WebView;

/**
 * A WebView that keeps playing media when the app is in the background.
 * Android's WebView pauses video elements once its window becomes invisible;
 * YouTube Music plays songs through a video element, so report "visible".
 */
public class BackgroundWebView extends WebView {
    public BackgroundWebView(Context context) {
        super(context);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        if (visibility != View.GONE) super.onWindowVisibilityChanged(View.VISIBLE);
    }
}
