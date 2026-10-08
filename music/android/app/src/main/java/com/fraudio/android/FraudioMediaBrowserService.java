package com.fraudio.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.support.v4.media.MediaBrowserCompat.MediaItem;
import android.support.v4.media.MediaDescriptionCompat;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.media.MediaBrowserServiceCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class FraudioMediaBrowserService extends MediaBrowserServiceCompat {

    private static final String TAG = "FraudioMediaService";
    private static final String CHANNEL_ID = "fraudio_playback_channel";
    private static final int NOTIFICATION_ID = 5101;
    private static final long WAKE_LOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000L;

    public static final String MEDIA_ROOT_ID = "fraudio_root";
    public static final String MEDIA_ID_AUDIOBOOKS = "fraudio_audiobooks";
    public static final String MEDIA_ID_MUSIC = "fraudio_music";
    public static final String MEDIA_ID_PLAYLISTS = "fraudio_playlists";
    public static final String MEDIA_ID_OFFLINE = "fraudio_offline";

    public static final String ACTION_REWIND_15 = "com.fraudio.android.ACTION_REWIND_15";
    public static final String ACTION_FORWARD_30 = "com.fraudio.android.ACTION_FORWARD_30";
    public static final String ACTION_PLAY = "com.fraudio.android.ACTION_PLAY";
    public static final String ACTION_PAUSE = "com.fraudio.android.ACTION_PAUSE";
    public static final String ACTION_NEXT = "com.fraudio.android.ACTION_NEXT";
    public static final String ACTION_PREV = "com.fraudio.android.ACTION_PREV";

    // Bridge actions used with the WebView player (lock screen / notification
    // controls while the web UI drives playback).
    public static final String ACTION_WEB_STATE = "com.fraudio.android.ACTION_WEB_STATE";
    public static final String EXTRA_WEB_STATE = "web_state";

    /**
     * Receives transport commands that should be applied to the WebView
     * player instead of the native MediaPlayer. MainActivity installs this
     * while it is alive and evaluates JS window.fraudioNativeCommand().
     */
    public interface WebCommandListener {
        void onWebCommand(String action, long value);
    }

    public interface CarConnectionListener {
        void onCarConnectionChanged(boolean connected);
    }

    private static volatile WebCommandListener webListener;
    private static volatile CarConnectionListener carListener;
    private static volatile boolean serviceRunning = false;
    private static volatile boolean automotiveConnected = false;

    public static void setWebCommandListener(WebCommandListener listener) {
        webListener = listener;
    }

    public static void setCarConnectionListener(CarConnectionListener listener) {
        carListener = listener;
        if (listener != null) {
            listener.onCarConnectionChanged(automotiveConnected);
        }
    }

    public static boolean isAutomotiveConnected() {
        return automotiveConnected;
    }

    public static boolean isRunning() {
        return serviceRunning;
    }

    private MediaSessionCompat mediaSession;
    private MediaPlayer mediaPlayer;
    private String currentMediaId = "";
    private String currentTitle = "FRAUDIO";
    private String currentArtist = "Library";
    private String currentAlbum = "";
    private long currentDuration = 0;

    private volatile boolean webDriven = false;
    private volatile boolean webPlaying = false;
    private volatile boolean foregrounded = false;

    private PowerManager.WakeLock wakeLock;
    private AudioManager audioManager;
    private Object audioFocusRequest;
    private boolean focusHeld = false;
    private final AudioManager.OnAudioFocusChangeListener legacyFocusListener =
        this::handleAudioFocusChange;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private Bitmap currentArt;
    private String webCoverUrl = "";
    private ExecutorService artworkExecutor;

    @Override
    public void onCreate() {
        super.onCreate();
        serviceRunning = true;
        artworkExecutor = Executors.newSingleThreadExecutor();
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);

        createNotificationChannel();

        // Initialize MediaSessionCompat
        mediaSession = new MediaSessionCompat(this, TAG);
        setSessionToken(mediaSession.getSessionToken());

        mediaSession.setCallback(new MediaSessionCallback());
        mediaSession.setFlags(
            MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS |
            MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
        );

        // Set initial playback state
        long actions = PlaybackStateCompat.ACTION_PLAY |
            PlaybackStateCompat.ACTION_PAUSE |
            PlaybackStateCompat.ACTION_PLAY_PAUSE |
            PlaybackStateCompat.ACTION_SKIP_TO_NEXT |
            PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS |
            PlaybackStateCompat.ACTION_FAST_FORWARD |
            PlaybackStateCompat.ACTION_REWIND |
            PlaybackStateCompat.ACTION_SEEK_TO;

        PlaybackStateCompat.Builder stateBuilder = new PlaybackStateCompat.Builder()
            .setActions(actions)
            .addCustomAction(ACTION_REWIND_15, "Rewind 15s", R.drawable.ic_launcher)
            .addCustomAction(ACTION_FORWARD_30, "Forward 30s", R.drawable.ic_launcher)
            .setState(PlaybackStateCompat.STATE_NONE, 0, 1.0f);

        mediaSession.setPlaybackState(stateBuilder.build());

        initMediaPlayer();
    }

    private void initMediaPlayer() {
        if (mediaPlayer != null) {
            mediaPlayer.release();
        }
        mediaPlayer = new MediaPlayer();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            mediaPlayer.setAudioAttributes(new AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .build());
        }

        mediaPlayer.setOnPreparedListener(mp -> {
            currentDuration = mp.getDuration();
            updateMetadata();
            requestAudioFocus();
            mp.start();
            setPlaybackState(PlaybackStateCompat.STATE_PLAYING, mp.getCurrentPosition());
            updateNotification();
        });

        mediaPlayer.setOnCompletionListener(mp -> {
            setPlaybackState(PlaybackStateCompat.STATE_PAUSED, 0);
            updateNotification();
        });

        mediaPlayer.setOnErrorListener((mp, what, extra) -> {
            Log.e(TAG, "MediaPlayer error: " + what + ", " + extra);
            setPlaybackState(PlaybackStateCompat.STATE_ERROR, 0);
            return false;
        });
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "FRAUDIO Playback",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Background audio playback, lock screen controls and Android Auto");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    @Nullable
    @Override
    public BrowserRoot onGetRoot(@NonNull String clientPackageName, int clientUid, @Nullable Bundle rootHints) {
        if (isAutomotiveClient(clientPackageName)) {
            automotiveConnected = true;
            if (carListener != null) {
                carListener.onCarConnectionChanged(true);
            }
        }
        // Return root node for Android Auto
        return new BrowserRoot(MEDIA_ROOT_ID, null);
    }

    private boolean isAutomotiveClient(String packageName) {
        if (packageName == null) return false;
        String lower = packageName.toLowerCase();
        return lower.contains("gearhead") || lower.contains("car") || lower.contains("automotive")
            || lower.contains("projection");
    }

    @Override
    public void onLoadChildren(@NonNull String parentId, @NonNull Result<List<MediaItem>> result) {
        if (MEDIA_ROOT_ID.equals(parentId)) {
            // Android Auto top-level categories
            List<MediaItem> items = new ArrayList<>();

            items.add(createBrowsableItem(
                MEDIA_ID_AUDIOBOOKS,
                "Audiobooks",
                "Your audiobook collection & chapters",
                "📖"
            ));

            items.add(createBrowsableItem(
                MEDIA_ID_MUSIC,
                "Music Library",
                "Songs, albums & artists",
                "🎵"
            ));

            items.add(createBrowsableItem(
                MEDIA_ID_PLAYLISTS,
                "Playlists",
                "Saved & smart playlists",
                "📋"
            ));

            items.add(createBrowsableItem(
                MEDIA_ID_OFFLINE,
                "Offline Downloads",
                "Audio saved on this device",
                "⚡"
            ));

            result.sendResult(items);
            return;
        }

        // Fetch children asynchronously from server / local cache
        result.detach();
        Executors.newSingleThreadExecutor().execute(() -> {
            List<MediaItem> children = loadRemoteOrCachedChildren(parentId);
            result.sendResult(children);
        });
    }

    private MediaItem createBrowsableItem(String mediaId, String title, String subtitle, String iconHint) {
        MediaDescriptionCompat desc = new MediaDescriptionCompat.Builder()
            .setMediaId(mediaId)
            .setTitle(title)
            .setSubtitle(subtitle)
            .build();
        return new MediaItem(desc, MediaItem.FLAG_BROWSABLE);
    }

    private MediaItem createPlayableItem(String mediaId, String title, String artist, String album, String coverUrl) {
        MediaDescriptionCompat.Builder builder = new MediaDescriptionCompat.Builder()
            .setMediaId(mediaId)
            .setTitle(title)
            .setSubtitle(artist)
            .setDescription(album);

        if (coverUrl != null && !coverUrl.isEmpty()) {
            builder.setIconUri(Uri.parse(coverUrl));
        }

        return new MediaItem(builder.build(), MediaItem.FLAG_PLAYABLE);
    }

    private String getBaseUrl() {
        SharedPreferences prefs = getSharedPreferences(MainActivity.PREFS_NAME, Context.MODE_PRIVATE);
        String mode = prefs.getString(MainActivity.KEY_MODE, MainActivity.MODE_CLOUD);
        if (MainActivity.MODE_LOCAL.equals(mode)) {
            String ip = prefs.getString(MainActivity.KEY_SERVER_IP, "127.0.0.1");
            return "http://" + ip + ":" + MainActivity.SERVER_PORT;
        }
        return MainActivity.CLOUD_URL;
    }

    private List<MediaItem> loadRemoteOrCachedChildren(String parentId) {
        List<MediaItem> items = new ArrayList<>();
        String baseUrl = getBaseUrl();

        try {
            if (MEDIA_ID_AUDIOBOOKS.equals(parentId)) {
                String jsonStr = httpGet(baseUrl + "/api/library?kind=audiobooks");
                if (jsonStr != null) {
                    JSONObject obj = new JSONObject(jsonStr);
                    JSONArray arr = obj.optJSONArray("items");
                    if (arr != null) {
                        for (int i = 0; i < arr.length(); i++) {
                            JSONObject item = arr.getJSONObject(i);
                            String id = item.optString("id");
                            String title = item.optString("title", "Audiobook");
                            String author = item.optString("author", item.optString("artist", "Unknown"));
                            String coverUrl = baseUrl + "/covers/" + id;
                            items.add(createPlayableItem(id, title, author, "Audiobook", coverUrl));
                        }
                    }
                }
            } else if (MEDIA_ID_MUSIC.equals(parentId)) {
                String jsonStr = httpGet(baseUrl + "/api/library?kind=music");
                if (jsonStr != null) {
                    JSONObject obj = new JSONObject(jsonStr);
                    JSONArray arr = obj.optJSONArray("items");
                    if (arr != null) {
                        for (int i = 0; i < arr.length(); i++) {
                            JSONObject item = arr.getJSONObject(i);
                            String id = item.optString("id");
                            String title = item.optString("title", "Track");
                            String artist = item.optString("artist", "Unknown Artist");
                            String album = item.optString("album", "Music");
                            String coverUrl = baseUrl + "/covers/" + id;
                            items.add(createPlayableItem(id, title, artist, album, coverUrl));
                        }
                    }
                }
            } else if (MEDIA_ID_PLAYLISTS.equals(parentId)) {
                String jsonStr = httpGet(baseUrl + "/api/playlists");
                if (jsonStr != null) {
                    JSONArray arr = new JSONArray(jsonStr);
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject pl = arr.getJSONObject(i);
                        String id = pl.optString("id");
                        String name = pl.optString("name", "Playlist");
                        int count = pl.optJSONArray("trackIds") != null ? pl.optJSONArray("trackIds").length() : 0;
                        items.add(createBrowsableItem("playlist:" + id, name, count + " tracks", "📋"));
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Error fetching children for " + parentId + ": " + e.getMessage());
        }

        if (items.isEmpty()) {
            items.add(createPlayableItem("offline_demo", "FRAUDIO Car Mode", "Ready for playback", "FRAUDIO", null));
        }

        return items;
    }

    private String httpGet(String urlStr) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(3000);
            conn.setReadTimeout(3000);
            conn.setRequestMethod("GET");
            if (conn.getResponseCode() == 200) {
                BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    sb.append(line);
                }
                reader.close();
                return sb.toString();
            }
        } catch (Exception ignored) {
        } finally {
            if (conn != null) conn.disconnect();
        }
        return null;
    }

    // ------------------------------------------------------------------
    // WebView bridge (media session driven by the web player)
    // ------------------------------------------------------------------

    private void handleWebState(String json) {
        if (json == null || json.isEmpty()) return;
        try {
            JSONObject obj = new JSONObject(json);
            boolean stop = obj.optBoolean("stop", false);
            boolean playing = obj.optBoolean("playing", false);
            long positionSec = obj.optLong("positionSec", 0);
            long durationSec = obj.optLong("durationSec", 0);

            if (stop) {
                endWebPlayback();
                return;
            }

            if (!webDriven) {
                // The WebView is taking over playback; silence any native
                // (Android Auto) stream so the two never fight for focus.
                try {
                    if (mediaPlayer != null && mediaPlayer.isPlaying()) {
                        mediaPlayer.pause();
                    }
                } catch (Exception ignored) {
                }
                abandonAudioFocus();
            }

            webDriven = true;
            webPlaying = playing;
            if (durationSec > 0) currentDuration = durationSec * 1000L;

            JSONObject meta = obj.optJSONObject("meta");
            if (meta != null) {
                currentTitle = meta.optString("title", currentTitle);
                currentArtist = meta.optString("artist", currentArtist);
                currentAlbum = meta.optString("album", currentAlbum);
                String cover = meta.optString("coverUrl", "");
                if (cover.startsWith("/")) {
                    SharedPreferences p = getSharedPreferences(MainActivity.PREFS_NAME, Context.MODE_PRIVATE);
                    String origin = p.getString(MainActivity.KEY_LAST_ORIGIN, "");
                    if (origin == null || origin.isEmpty()) origin = getBaseUrl();
                    cover = origin + cover;
                }
                if (!cover.equals(webCoverUrl)) {
                    webCoverUrl = cover;
                    loadArtwork(cover);
                }
            }

            if (playing && !foregrounded) {
                ensureForeground();
            }

            mediaSession.setActive(true);
            updateMetadata();
            setSessionState(
                playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                positionSec * 1000L
            );
            updateWakeLock(playing);
            // Chromium owns audio focus for the WebView's <audio> element.
            // Grabbing it here would fire AUDIOFOCUS_LOSS inside WebView and
            // make it pause itself right after playback starts.
            if (foregrounded) {
                updateNotification();
            }
        } catch (Exception e) {
            Log.e(TAG, "handleWebState failed", e);
        }
    }

    private void endWebPlayback() {
        webDriven = false;
        webPlaying = false;
        updateWakeLock(false);
        abandonAudioFocus();
        if (foregrounded) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            foregrounded = false;
        }
        mediaSession.setActive(false);
        setSessionState(PlaybackStateCompat.STATE_NONE, 0);
        stopSelf();
    }

    private void sendWebCommand(String action, long value) {
        WebCommandListener listener = webListener;
        if (listener != null) {
            listener.onWebCommand(action, value);
        }
    }

    /** Play/pause/next/prev invoked from the notification, lock screen or headset. */
    private void handleTransportAction(String action) {
        if (webDriven) {
            if (ACTION_PLAY.equals(action)) {
                webPlaying = true;
                setSessionState(PlaybackStateCompat.STATE_PLAYING, currentSessionPosition());
                sendWebCommand("play", 0);
            } else if (ACTION_PAUSE.equals(action)) {
                webPlaying = false;
                setSessionState(PlaybackStateCompat.STATE_PAUSED, currentSessionPosition());
                sendWebCommand("pause", 0);
            } else if (ACTION_NEXT.equals(action)) {
                sendWebCommand("next", 0);
            } else if (ACTION_PREV.equals(action)) {
                sendWebCommand("prev", 0);
            } else if (ACTION_REWIND_15.equals(action)) {
                sendWebCommand("rewind", 0);
            } else if (ACTION_FORWARD_30.equals(action)) {
                sendWebCommand("forward", 0);
            }
            ensureForeground();
            mediaSession.setActive(true);
            updateWakeLock(webPlaying);
            updateNotification();
            return;
        }

        if (mediaPlayer == null) return;
        try {
            if (ACTION_PLAY.equals(action) && !mediaPlayer.isPlaying()) {
                requestAudioFocus();
                mediaPlayer.start();
                setPlaybackState(PlaybackStateCompat.STATE_PLAYING, mediaPlayer.getCurrentPosition());
            } else if (ACTION_PAUSE.equals(action) && mediaPlayer.isPlaying()) {
                mediaPlayer.pause();
                setPlaybackState(PlaybackStateCompat.STATE_PAUSED, mediaPlayer.getCurrentPosition());
            } else if (ACTION_REWIND_15.equals(action)) {
                int pos = Math.max(0, mediaPlayer.getCurrentPosition() - 15000);
                mediaPlayer.seekTo(pos);
                setPlaybackState(mediaPlayer.isPlaying() ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED, pos);
            } else if (ACTION_FORWARD_30.equals(action)) {
                int pos = Math.min((int) (currentDuration > 0 ? currentDuration : Integer.MAX_VALUE),
                    mediaPlayer.getCurrentPosition() + 30000);
                mediaPlayer.seekTo(pos);
                setPlaybackState(mediaPlayer.isPlaying() ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED, pos);
            }
        } catch (Exception e) {
            Log.w(TAG, "Transport action failed: " + e.getMessage());
        }
        updateNotification();
    }

    private long currentSessionPosition() {
        PlaybackStateCompat state = mediaSession.getController().getPlaybackState();
        return state == null ? 0 : state.getPosition();
    }

    private void loadArtwork(final String coverUrl) {
        currentArt = null;
        if (coverUrl == null || coverUrl.isEmpty()) {
            mainHandler.post(this::updateMetadata);
            return;
        }
        artworkExecutor.execute(() -> {
            Bitmap bmp = null;
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(coverUrl).openConnection();
                conn.setConnectTimeout(4000);
                conn.setReadTimeout(4000);
                if (conn.getResponseCode() == 200) {
                    bmp = BitmapFactory.decodeStream(conn.getInputStream());
                }
            } catch (Exception ignored) {
            } finally {
                if (conn != null) conn.disconnect();
            }
            currentArt = bmp;
            if (bmp != null) {
                mainHandler.post(() -> {
                    updateMetadata();
                    if (foregrounded) updateNotification();
                });
            }
        });
    }

    private void updateWakeLock(boolean acquire) {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm == null) return;
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fraudio:playback");
                wakeLock.setReferenceCounted(false);
            }
            if (wakeLock.isHeld()) {
                wakeLock.release();
            }
            if (acquire) {
                // Refreshed by the web player's periodic state push; expires on
                // its own if the page dies so it can never leak forever.
                wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
            }
        } catch (Exception e) {
            Log.w(TAG, "Wake lock error: " + e.getMessage());
        }
    }

    private boolean requestAudioFocus() {
        if (audioManager == null) return true;
        // Only the native MediaPlayer path uses this; the WebView player's
        // audio is owned by Chromium, which manages its own focus.
        try {
            boolean granted;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (audioFocusRequest == null) {
                    AudioAttributes attrs = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build();
                    AudioFocusRequest request = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(attrs)
                        .setWillPauseWhenDucked(true)
                        .setOnAudioFocusChangeListener(this::handleAudioFocusChange, mainHandler)
                        .build();
                    audioFocusRequest = request;
                }
                granted = audioManager.requestAudioFocus((AudioFocusRequest) audioFocusRequest)
                    == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
            } else {
                granted = audioManager.requestAudioFocus(legacyFocusListener,
                    AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
                    == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
            }
            focusHeld = granted;
            return granted;
        } catch (Exception e) {
            Log.w(TAG, "Audio focus request failed: " + e.getMessage());
            return false;
        }
    }

    private void abandonAudioFocus() {
        if (audioManager == null || !focusHeld) return;
        focusHeld = false;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
                audioManager.abandonAudioFocusRequest((AudioFocusRequest) audioFocusRequest);
            } else {
                audioManager.abandonAudioFocus(legacyFocusListener);
            }
        } catch (Exception ignored) {
        }
    }

    private void handleAudioFocusChange(int focusChange) {
        if (focusChange == AudioManager.AUDIOFOCUS_LOSS ||
            focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            if (webDriven) {
                webPlaying = false;
                setSessionState(PlaybackStateCompat.STATE_PAUSED, currentSessionPosition());
                sendWebCommand("pause", 0);
                updateWakeLock(false);
                updateNotification();
            } else if (mediaPlayer != null && mediaPlayer.isPlaying()) {
                mediaPlayer.pause();
                setPlaybackState(PlaybackStateCompat.STATE_PAUSED, mediaPlayer.getCurrentPosition());
                updateNotification();
            }
        }
    }

    private boolean isEffectivelyPlaying() {
        if (webDriven) return webPlaying;
        return mediaPlayer != null && mediaPlayer.isPlaying();
    }

    private void ensureForeground() {
        if (foregrounded) return;
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        foregrounded = true;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            // Sticky restart with no work to do (e.g. process was killed).
            stopSelf();
            return START_NOT_STICKY;
        }
        String act = intent.getAction();
        if (ACTION_WEB_STATE.equals(act)) {
            handleWebState(intent.getStringExtra(EXTRA_WEB_STATE));
        } else if (act != null) {
            handleTransportAction(act);
        }
        return super.onStartCommand(intent, flags, startId);
    }

    private void setSessionState(int state, long positionMs) {
        long actions = PlaybackStateCompat.ACTION_PLAY |
            PlaybackStateCompat.ACTION_PAUSE |
            PlaybackStateCompat.ACTION_PLAY_PAUSE |
            PlaybackStateCompat.ACTION_SKIP_TO_NEXT |
            PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS |
            PlaybackStateCompat.ACTION_FAST_FORWARD |
            PlaybackStateCompat.ACTION_REWIND |
            PlaybackStateCompat.ACTION_SEEK_TO;

        PlaybackStateCompat.Builder builder = new PlaybackStateCompat.Builder()
            .setActions(actions)
            .addCustomAction(ACTION_REWIND_15, "Rewind 15s", R.drawable.ic_launcher)
            .addCustomAction(ACTION_FORWARD_30, "Forward 30s", R.drawable.ic_launcher)
            .setState(state, positionMs, 1.0f);

        mediaSession.setPlaybackState(builder.build());
    }

    private void setPlaybackState(int state, long position) {
        setSessionState(state, position);
    }

    private void updateMetadata() {
        MediaMetadataCompat.Builder meta = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_MEDIA_ID, currentMediaId)
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, currentTitle)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, currentArtist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, currentAlbum)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, currentDuration);

        Bitmap art = currentArt;
        if (art != null) {
            meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art);
        } else {
            try {
                Bitmap icon = BitmapFactory.decodeResource(getResources(), R.drawable.ic_launcher);
                if (icon != null) {
                    meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, icon);
                }
            } catch (Exception ignored) {}
        }

        mediaSession.setMetadata(meta.build());
    }

    private void updateNotification() {
        Notification notification = buildNotification();
        if (foregrounded) {
            NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.notify(NOTIFICATION_ID, notification);
            }
        } else {
            // Legacy Android Auto path: promote to foreground on first playback.
            ensureForeground();
        }
    }

    private Notification buildNotification() {
        PendingIntent intent = PendingIntent.getActivity(
            this,
            0,
            new Intent(this, MainActivity.class),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        boolean isPlaying = isEffectivelyPlaying();

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(currentTitle)
            .setContentText(currentArtist)
            .setSubText(currentAlbum)
            .setSmallIcon(R.drawable.ic_launcher)
            .setLargeIcon(currentArt)
            .setContentIntent(intent)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                .setMediaSession(mediaSession.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2));

        // Previous
        builder.addAction(new NotificationCompat.Action(
            android.R.drawable.ic_media_previous, "Previous",
            createActionIntent(ACTION_PREV)
        ));

        // Play / Pause
        if (isPlaying) {
            builder.addAction(new NotificationCompat.Action(
                android.R.drawable.ic_media_pause, "Pause",
                createActionIntent(ACTION_PAUSE)
            ));
        } else {
            builder.addAction(new NotificationCompat.Action(
                android.R.drawable.ic_media_play, "Play",
                createActionIntent(ACTION_PLAY)
            ));
        }

        // Next
        builder.addAction(new NotificationCompat.Action(
            android.R.drawable.ic_media_next, "Next",
            createActionIntent(ACTION_NEXT)
        ));

        // Rewind 15s (expanded view)
        builder.addAction(new NotificationCompat.Action(
            android.R.drawable.ic_media_rew, "Rewind 15s",
            createActionIntent(ACTION_REWIND_15)
        ));

        // Fast Forward 30s (expanded view)
        builder.addAction(new NotificationCompat.Action(
            android.R.drawable.ic_media_ff, "Forward 30s",
            createActionIntent(ACTION_FORWARD_30)
        ));

        return builder.build();
    }

    private PendingIntent createActionIntent(String action) {
        Intent intent = new Intent(this, FraudioMediaBrowserService.class);
        intent.setAction(action);
        return PendingIntent.getService(this, action.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private class MediaSessionCallback extends MediaSessionCompat.Callback {
        @Override
        public void onPlay() {
            if (webDriven) {
                handleTransportAction(ACTION_PLAY);
                return;
            }
            if (mediaPlayer != null && !mediaPlayer.isPlaying()) {
                mediaPlayer.start();
                setPlaybackState(PlaybackStateCompat.STATE_PLAYING, mediaPlayer.getCurrentPosition());
                updateNotification();
            }
        }

        @Override
        public void onPause() {
            if (webDriven) {
                handleTransportAction(ACTION_PAUSE);
                return;
            }
            if (mediaPlayer != null && mediaPlayer.isPlaying()) {
                mediaPlayer.pause();
                setPlaybackState(PlaybackStateCompat.STATE_PAUSED, mediaPlayer.getCurrentPosition());
                updateNotification();
            }
        }

        @Override
        public void onSkipToNext() {
            if (webDriven) sendWebCommand("next", 0);
        }

        @Override
        public void onSkipToPrevious() {
            if (webDriven) sendWebCommand("prev", 0);
        }

        @Override
        public void onFastForward() {
            if (webDriven) {
                sendWebCommand("forward", 0);
                return;
            }
            if (mediaPlayer != null) {
                int pos = mediaPlayer.getCurrentPosition() + 30000;
                mediaPlayer.seekTo(pos);
                setPlaybackState(mediaPlayer.isPlaying() ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED, pos);
            }
        }

        @Override
        public void onRewind() {
            if (webDriven) {
                sendWebCommand("rewind", 0);
                return;
            }
            if (mediaPlayer != null) {
                int pos = Math.max(0, mediaPlayer.getCurrentPosition() - 15000);
                mediaPlayer.seekTo(pos);
                setPlaybackState(mediaPlayer.isPlaying() ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED, pos);
            }
        }

        @Override
        public void onSeekTo(long pos) {
            if (webDriven) {
                sendWebCommand("seek", pos / 1000L);
                return;
            }
            if (mediaPlayer != null) {
                mediaPlayer.seekTo((int) pos);
                setPlaybackState(mediaPlayer.isPlaying() ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED, pos);
            }
        }

        @Override
        public void onCustomAction(String action, Bundle extras) {
            if (ACTION_REWIND_15.equals(action)) {
                onRewind();
            } else if (ACTION_FORWARD_30.equals(action)) {
                onFastForward();
            }
        }

        @Override
        public void onPlayFromMediaId(String mediaId, Bundle extras) {
            currentMediaId = mediaId;
            String streamUrl = getBaseUrl() + "/api/stream/" + mediaId;

            try {
                if (mediaPlayer == null) initMediaPlayer();
                mediaPlayer.reset();
                mediaPlayer.setDataSource(streamUrl);
                setPlaybackState(PlaybackStateCompat.STATE_BUFFERING, 0);
                mediaPlayer.prepareAsync();
            } catch (Exception e) {
                Log.e(TAG, "Error playing mediaId: " + mediaId, e);
            }
        }
    }

    @Override
    public void onDestroy() {
        serviceRunning = false;
        if (mediaPlayer != null) {
            mediaPlayer.release();
            mediaPlayer = null;
        }
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
        abandonAudioFocus();
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception ignored) {
        }
        if (artworkExecutor != null) {
            artworkExecutor.shutdownNow();
        }
        if (foregrounded) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            foregrounded = false;
        }
        automotiveConnected = false;
        if (carListener != null) {
            carListener.onCarConnectionChanged(false);
        }
        super.onDestroy();
    }
}
