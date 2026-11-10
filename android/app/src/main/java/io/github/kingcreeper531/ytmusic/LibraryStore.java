package io.github.kingcreeper531.ytmusic;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.List;
import java.util.UUID;

/** "My Music": audio files copied into the app's private storage, plus an index. */
final class LibraryStore {
    private final File root;
    private final File filesDir;
    private final File artDir;
    private final File index;
    private final ContentResolver resolver;
    private JSONArray tracks;

    LibraryStore(Context ctx) {
        root = new File(ctx.getFilesDir(), "library");
        filesDir = new File(root, "files");
        artDir = new File(root, "art");
        index = new File(root, "library.json");
        resolver = ctx.getContentResolver();
    }

    private synchronized JSONArray load() {
        if (tracks != null) return tracks;
        tracks = new JSONArray();
        try {
            if (index.exists()) {
                JSONArray all = new JSONArray(new String(Files.readAllBytes(index.toPath()), StandardCharsets.UTF_8));
                for (int i = 0; i < all.length(); i++) {
                    JSONObject t = all.getJSONObject(i);
                    if (new File(filesDir, t.getString("file")).exists()) tracks.put(t);
                }
            }
        } catch (Exception ignored) { }
        return tracks;
    }

    private synchronized void save() {
        try {
            root.mkdirs();
            Files.write(index.toPath(), tracks.toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) { }
    }

    /** JSON for the page: adds playable file:// URLs. */
    synchronized String listJson() {
        JSONArray out = new JSONArray();
        try {
            JSONArray all = load();
            for (int i = 0; i < all.length(); i++) {
                JSONObject t = all.getJSONObject(i);
                JSONObject o = new JSONObject();
                o.put("id", t.getString("id"));
                o.put("title", t.optString("title"));
                o.put("artist", t.optString("artist"));
                o.put("album", t.optString("album"));
                o.put("duration", t.optDouble("duration", 0));
                o.put("src", Uri.fromFile(new File(filesDir, t.getString("file"))).toString());
                if (!t.optString("art").isEmpty()) o.put("art", Uri.fromFile(new File(artDir, t.getString("art"))).toString());
                out.put(o);
            }
        } catch (Exception ignored) { }
        return out.toString();
    }

    /** Copies picked files into the library. Returns {"added":n,"skipped":m}. */
    String importUris(List<Uri> uris) {
        filesDir.mkdirs();
        artDir.mkdirs();
        int added = 0;
        int skipped = 0;
        for (Uri uri : uris) {
            File tmp = null;
            try {
                String name = displayName(uri);
                String ext = extension(uri, name);
                String id = UUID.randomUUID().toString();
                tmp = new File(filesDir, id + ".tmp");
                String hash = copyAndHash(uri, tmp);
                if (hasHash(hash)) { skipped++; tmp.delete(); continue; }

                String file = id + "." + ext;
                File dest = new File(filesDir, file);
                if (!tmp.renameTo(dest)) throw new Exception("rename failed");

                String title = null, artist = null, album = null, art = null;
                double duration = 0;
                MediaMetadataRetriever r = new MediaMetadataRetriever();
                try {
                    r.setDataSource(dest.getAbsolutePath());
                    title = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE);
                    artist = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST);
                    if (artist == null) artist = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST);
                    album = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM);
                    String d = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
                    if (d != null) duration = Long.parseLong(d) / 1000.0;
                    byte[] pic = r.getEmbeddedPicture();
                    if (pic != null && pic.length > 0) {
                        art = id + ".img";
                        try (FileOutputStream fos = new FileOutputStream(new File(artDir, art))) { fos.write(pic); }
                    }
                } catch (Exception ignored) {
                    // Not readable as audio
                } finally {
                    try { r.release(); } catch (Exception ignored) { }
                }
                if (duration <= 0 && title == null) { // not an audio file Android can play
                    dest.delete();
                    skipped++;
                    continue;
                }

                JSONObject t = new JSONObject();
                t.put("id", id);
                t.put("hash", hash);
                t.put("file", file);
                if (art != null) t.put("art", art);
                t.put("title", title != null && !title.trim().isEmpty() ? title.trim() : stripExt(name));
                t.put("artist", artist != null && !artist.trim().isEmpty() ? artist.trim() : "Unknown artist");
                t.put("album", album != null ? album.trim() : "");
                t.put("duration", duration);
                t.put("added", System.currentTimeMillis());
                synchronized (this) { load().put(t); save(); }
                added++;
            } catch (Exception e) {
                if (tmp != null) tmp.delete();
                skipped++;
            }
        }
        return "{\"added\":" + added + ",\"skipped\":" + skipped + "}";
    }

    synchronized void remove(String id) {
        JSONArray all = load();
        JSONArray keep = new JSONArray();
        for (int i = 0; i < all.length(); i++) {
            JSONObject t = all.optJSONObject(i);
            if (t == null) continue;
            if (t.optString("id").equals(id)) {
                new File(filesDir, t.optString("file")).delete();
                if (!t.optString("art").isEmpty()) new File(artDir, t.optString("art")).delete();
            } else {
                keep.put(t);
            }
        }
        tracks = keep;
        save();
    }

    private synchronized boolean hasHash(String hash) {
        JSONArray all = load();
        for (int i = 0; i < all.length(); i++) {
            if (hash.equals(all.optJSONObject(i).optString("hash"))) return true;
        }
        return false;
    }

    private String copyAndHash(Uri uri, File dest) throws Exception {
        MessageDigest sha = MessageDigest.getInstance("SHA-1");
        try (InputStream in = resolver.openInputStream(uri); FileOutputStream out = new FileOutputStream(dest)) {
            if (in == null) throw new Exception("can't open");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                sha.update(buf, 0, n);
            }
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : sha.digest()) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private String displayName(Uri uri) {
        try (Cursor c = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) { }
        String last = uri.getLastPathSegment();
        return last != null ? last : "Unknown";
    }

    private String extension(Uri uri, String name) {
        int dot = name.lastIndexOf('.');
        if (dot > 0 && dot < name.length() - 1) {
            String e = name.substring(dot + 1).toLowerCase();
            if (e.matches("[a-z0-9]{1,5}")) return e;
        }
        String fromMime = MimeTypeMap.getSingleton().getExtensionFromMimeType(resolver.getType(uri));
        return fromMime != null ? fromMime : "audio";
    }

    private static String stripExt(String name) {
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) : name;
    }
}
