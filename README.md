# YouTube Music Desktop

An unofficial Windows desktop app for [YouTube Music](https://music.youtube.com), with ad blocking built in.

## Features

- **No ads.** Ads are removed from the player's data before they can play, ad and tracker requests are blocked (EasyList and EasyPrivacy), and anything that slips through is skipped.
- **SponsorBlock.** Skips the non-music intros and outros in music videos.
- **No interruptions.** No "Are you still there?" pauses, no Premium upsell popups, and music keeps playing when the window is minimized or closed to the tray.
- **Discord Rich Presence.** Shows "Listening to" with the song, artist, album art, a progress bar and a "Listen on YouTube Music" button. When paused, it shows "(Paused)".
- **My Music.** Add your own MP3, M4A, FLAC, WAV, OGG or Opus files (button or drag and drop) and play them with a built-in player. They show in Discord too. Open it with the **My Music** button in the top bar or **Ctrl+L**.
- **Spotify import.** Bring your Spotify playlists and Liked Songs over (or import an exported CSV/JSON file). Each song is matched to YouTube Music, and you can play the whole playlist in the app. Open it with the **Playlists** button in the top bar or **Ctrl+I**.
- **Tray controls.** Play/pause, next and previous from the tray icon.
- **Auto-update.** A green **Update** button appears in the top bar when a new release is out.

## Download

Get the latest release from the [Releases page](https://github.com/KingCreeper531/youtube-music-desktop/releases/latest):

- `YouTube-Music-Setup-x.y.z.exe`: installer (recommended). It updates itself.
- `YouTube-Music-Portable-x.y.z.exe`: runs without installing.

- `YouTube-Music-Android-x.y.z.apk`: Android app (Android 8 or newer).

Windows SmartScreen may warn about the app because it isn't code-signed. Click **More info**, then **Run anyway**.

### Android

Download the APK on your phone and open it. Android asks once to allow installs from your browser or file manager. The Android app has ad blocking, SponsorBlock, background play with lock-screen controls, **My Music** (tap the music-note button in the top bar to add songs from your phone), and the same green **Update** button. Google usually blocks sign-in inside apps like this, so expect to listen signed out. Discord status isn't available on Android.

## Discord setup

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application. The name you give it is what shows after "Listening to".
2. Copy its **Application ID**.
3. In the app, press **Ctrl+,** to open settings and paste the ID under Discord Rich Presence.

## Spotify import setup

Spotify requires every app that reads your playlists to have its own free developer app:

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and click **Create app**.
2. Add `http://127.0.0.1:43821/callback` as a **Redirect URI**, tick **Web API**, and save.
3. In the app, open **Playlists**, click **Import from Spotify**, paste the app's **Client ID** and click **Connect**.

No developer app? Export your playlists as CSV (for example with Exportify) or request your data from Spotify's account privacy page, then use **Import a file**.

## Shortcuts

| Key | Action |
| --- | --- |
| Ctrl+, | Settings |
| Ctrl+L | My Music |
| Ctrl+I | Playlists (Spotify import) |
| F5 / Ctrl+R | Reload |
| Alt+Left / Alt+Right | Back / forward |

## Building from source

```bash
npm install
npm start            # run in development
npm run dist         # build the installer and portable .exe into dist/
npm run release      # build and publish a GitHub release (maintainer)
```

This project isn't affiliated with or endorsed by Google or YouTube.
