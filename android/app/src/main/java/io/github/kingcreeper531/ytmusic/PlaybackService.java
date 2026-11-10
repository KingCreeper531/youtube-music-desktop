package io.github.kingcreeper531.ytmusic;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Keeps the app alive while music plays in the background and provides the
 * media notification / lock-screen controls.
 */
public class PlaybackService extends Service {
    private static final String CHANNEL = "playback";
    private static final int NOTIFICATION_ID = 1;
    private static final String ACTION_TOGGLE = "toggle";
    private static final String ACTION_NEXT = "next";
    private static final String ACTION_PREVIOUS = "previous";

    private static PlaybackService instance;
    private static NowPlaying latest;

    private MediaSession session;
    private NotificationManager notifications;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private String artUrl;
    private Bitmap art;
    private boolean foreground;

    /** Called on the main thread whenever the page reports a change. */
    static void update(Context ctx, NowPlaying np) {
        latest = np;
        if (instance != null) {
            instance.apply();
        } else if (np.playing && !np.title.isEmpty()) {
            try {
                ctx.startForegroundService(new Intent(ctx, PlaybackService.class));
            } catch (Exception ignored) { /* not allowed right now; next update retries */ }
        }
    }

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, PlaybackService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        notifications = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Playback", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        notifications.createNotificationChannel(ch);

        session = new MediaSession(this, "YouTubeMusic");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { send("play", 0); }
            @Override public void onPause() { send("pause", 0); }
            @Override public void onSkipToNext() { send("next", 0); }
            @Override public void onSkipToPrevious() { send("previous", 0); }
            @Override public void onSeekTo(long pos) { send("seek", pos / 1000.0); }
            @Override public void onStop() { send("pause", 0); }
        });
        session.setSessionActivity(openAppIntent());
        session.setActive(true);
    }

    private static void send(String action, double arg) {
        MainActivity a = MainActivity.get();
        if (a != null) a.control(action, arg);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_TOGGLE.equals(action)) send("toggle", 0);
        else if (ACTION_NEXT.equals(action)) send("next", 0);
        else if (ACTION_PREVIOUS.equals(action)) send("previous", 0);
        // startForegroundService() requires startForeground() promptly.
        goForeground(buildNotification());
        apply();
        return START_NOT_STICKY;
    }

    private void apply() {
        NowPlaying np = latest;
        if (np == null) return;

        if (np.artwork != null && !np.artwork.equals(artUrl)) {
            artUrl = np.artwork;
            art = null;
            loadArt(artUrl);
        }

        MediaMetadata.Builder md = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, np.title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, np.artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, np.album)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, np.durationMs);
        if (art != null) md.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
        session.setMetadata(md.build());

        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                        | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                        | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_STOP)
                .setState(np.playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                        np.positionMs, np.playing ? 1f : 0f, SystemClock.elapsedRealtime())
                .build());

        Notification n = buildNotification();
        if (np.playing) {
            goForeground(n);
        } else if (foreground) {
            // Paused: let the notification be swiped away, but keep the controls.
            stopForeground(STOP_FOREGROUND_DETACH);
            foreground = false;
        }
        notifications.notify(NOTIFICATION_ID, n);
    }

    private void goForeground(Notification n) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
            foreground = true;
        } catch (Exception ignored) { /* background start not allowed; notification still updates */ }
    }

    private Notification buildNotification() {
        NowPlaying np = latest != null ? latest : new NowPlaying();
        boolean playing = np.playing;
        Notification.Builder b = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(np.title.isEmpty() ? "YouTube Music" : np.title)
                .setContentText(np.artist)
                .setContentIntent(openAppIntent())
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setOngoing(playing)
                .addAction(action(android.R.drawable.ic_media_previous, "Previous", ACTION_PREVIOUS))
                .addAction(action(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        playing ? "Pause" : "Play", ACTION_TOGGLE))
                .addAction(action(android.R.drawable.ic_media_next, "Next", ACTION_NEXT))
                .setStyle(new Notification.MediaStyle()
                        .setMediaSession(session.getSessionToken())
                        .setShowActionsInCompactView(0, 1, 2));
        if (art != null) b.setLargeIcon(art);
        return b.build();
    }

    private Notification.Action action(int icon, String title, String action) {
        Intent i = new Intent(this, PlaybackService.class).setAction(action);
        PendingIntent pi = PendingIntent.getService(this, action.hashCode(), i,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Action.Builder(Icon.createWithResource(this, icon), title, pi).build();
    }

    private PendingIntent openAppIntent() {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void loadArt(String url) {
        if (url == null || !url.startsWith("https://")) return;
        io.execute(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(5000);
                c.setReadTimeout(5000);
                try (InputStream in = c.getInputStream()) {
                    Bitmap bmp = BitmapFactory.decodeStream(in);
                    main.post(() -> {
                        if (url.equals(artUrl) && bmp != null) {
                            art = bmp;
                            apply();
                        }
                    });
                }
            } catch (Exception ignored) { }
        });
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // App swiped away from recents: stop playback and the notification.
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        instance = null;
        session.setActive(false);
        session.release();
        notifications.cancel(NOTIFICATION_ID);
        io.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
