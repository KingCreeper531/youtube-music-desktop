# YouTube Music Desktop

An unofficial Windows desktop app for [YouTube Music](https://music.youtube.com), with ad blocking built in.

## Features

- **No ads.** Ads are removed from the player's data before they can play, ad and tracker requests are blocked (EasyList and EasyPrivacy), and anything that slips through is skipped.
- **SponsorBlock.** Skips the non-music intros and outros in music videos.
- **No interruptions.** No "Are you still there?" pauses, no Premium upsell popups, and music keeps playing when the window is minimized or closed to the tray.
- **Discord Rich Presence.** Shows "Listening to" with the song, artist, album art, a progress bar and a "Listen on YouTube Music" button. When paused, it shows "(Paused)".
- **Tray controls.** Play/pause, next and previous from the tray icon.
- **Auto-update.** A green **Update** button appears in the top bar when a new release is out.

## Download

Get the latest release from the [Releases page](https://github.com/KingCreeper531/youtube-music-desktop/releases/latest):

- `YouTube-Music-Setup-x.y.z.exe`: installer (recommended). It updates itself.
- `YouTube-Music-Portable-x.y.z.exe`: runs without installing.

- `YouTube-Music-Android-x.y.z.apk`: Android app (Android 8 or newer).

Windows SmartScreen may warn about the app because it isn't code-signed. Click **More info**, then **Run anyway**.

### Android

Download the APK on your phone and open it. Android asks once to allow installs from your browser or file manager. The Android app has ad blocking, SponsorBlock, background play with lock-screen controls, and the same green **Update** button. Google usually blocks sign-in inside apps like this, so expect to listen signed out. Discord status isn't available on Android.

## Discord setup

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application. The name you give it is what shows after "Listening to".
2. Copy its **Application ID**.
3. In the app, press **Ctrl+,** to open settings and paste the ID under Discord Rich Presence.

## Shortcuts

| Key | Action |
| --- | --- |
| Ctrl+, | Settings |
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
