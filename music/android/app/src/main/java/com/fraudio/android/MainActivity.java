package com.fraudio.android;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.InputStream;

public class MainActivity extends Activity {

    private static final String TAG = "FraudioAndroid";
    public static final String CLOUD_URL = "https://music.butfree.online";
    public static final String PREFS_NAME = "fraudio_prefs";
    public static final String KEY_MODE = "mode";
    public static final String MODE_CLOUD = "cloud";
    public static final String MODE_LOCAL = "local";
    public static final String KEY_SERVER_IP = "server_ip";
    public static final int SERVER_PORT = 5100;
    public static final String KEY_LAST_ORIGIN = "last_origin";

    private WebView webView;
    private ProgressBar webViewProgress;

    private boolean isOfflineMode = false;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private long lastBackPressTime = 0;

    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;

    // Fullscreen view callback
    private FrameLayout fullscreenContainer;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        webViewProgress = findViewById(R.id.webview_progress);

        initWebView();
        registerNetworkCallback();
        registerNativeMediaBridge();
        requestNotificationPermissionIfNeeded();

        if (isNetworkAvailable()) {
            connectToCloud();
        } else {
            launchOfflineMode();
        }
    }

    private void initWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccess(true);

        // Viewport and performance settings
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUserAgentString(settings.getUserAgentString() + " FRAUDIO-Android");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        WebView.setWebContentsDebuggingEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.addJavascriptInterface(new FraudioBridge(), "FraudioNative");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return false;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (request != null && request.getUrl() != null) {
                    String url = request.getUrl().toString();
                    if (url.contains("/offline.html")) {
                        try {
                            InputStream is = getAssets().open("offline/offline.html");
                            return new WebResourceResponse("text/html", "UTF-8", is);
                        } catch (Exception e) {
                            Log.e(TAG, "Failed to load bundled offline player asset", e);
                        }
                    }
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                super.onReceivedError(view, errorCode, description, failingUrl);
                handlePageError(failingUrl);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request != null && request.isForMainFrame()) {
                    String failingUrl = request.getUrl() != null ? request.getUrl().toString() : "";
                    handlePageError(failingUrl);
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (webViewProgress != null) {
                    if (newProgress < 100) {
                        webViewProgress.setVisibility(View.VISIBLE);
                        webViewProgress.setProgress(newProgress);
                    } else {
                        webViewProgress.setVisibility(View.GONE);
                    }
                }
                super.onProgressChanged(view, newProgress);
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                try {
                    if (customView != null) {
                        callback.onCustomViewHidden();
                        return;
                    }
                    customView = view;
                    customViewCallback = callback;

                    if (fullscreenContainer == null) {
                        fullscreenContainer = new FrameLayout(MainActivity.this);
                        fullscreenContainer.setBackgroundColor(Color.BLACK);
                    } else {
                        fullscreenContainer.removeAllViews();
                    }

                    if (view.getParent() instanceof ViewGroup) {
                        ((ViewGroup) view.getParent()).removeView(view);
                    }

                    fullscreenContainer.addView(view, new FrameLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT));

                    FrameLayout parent = findViewById(android.R.id.content);
                    parent.addView(fullscreenContainer, new FrameLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT));

                    webView.setVisibility(View.GONE);
                    hideSystemUI();
                } catch (Exception e) {
                    customView = null;
                    customViewCallback = null;
                    try { callback.onCustomViewHidden(); } catch (Exception ignored) {}
                }
            }

            @Override
            public void onHideCustomView() {
                try {
                    if (customView == null) return;

                    FrameLayout parent = findViewById(android.R.id.content);
                    parent.removeView(fullscreenContainer);
                    fullscreenContainer.removeAllViews();

                    webView.setVisibility(View.VISIBLE);
                    showSystemUI();

                    customView = null;
                    if (customViewCallback != null) {
                        customViewCallback.onCustomViewHidden();
                        customViewCallback = null;
                    }
                } catch (Exception e) {
                    customView = null;
                    customViewCallback = null;
                    webView.setVisibility(View.VISIBLE);
                }
            }
        });
    }

    private void handlePageError(String failingUrl) {
        if (failingUrl != null && !failingUrl.contains("/offline.html") && !failingUrl.equals("about:blank")) {
            Log.w(TAG, "Connection failed to " + failingUrl + ", automatically switching to Offline Mode");
            mainHandler.post(() -> {
                if (!isFinishing()) {
                    launchOfflineMode();
                }
            });
        }
    }

    private boolean isNetworkAvailable() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Network activeNetwork = cm.getActiveNetwork();
                if (activeNetwork == null) return false;
                NetworkCapabilities caps = cm.getNetworkCapabilities(activeNetwork);
                return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            } else {
                android.net.NetworkInfo ni = cm.getActiveNetworkInfo();
                return ni != null && ni.isConnected();
            }
        } catch (Exception e) {
            return false;
        }
    }

    private void registerNetworkCallback() {
        try {
            connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (connectivityManager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                networkCallback = new ConnectivityManager.NetworkCallback() {
                    @Override
                    public void onAvailable(Network network) {
                        mainHandler.post(() -> {
                            Log.d(TAG, "Network available: notifying WebView");
                            if (isOfflineMode || !hasContentLoaded()) {
                                connectToCloud();
                            }
                            if (webView != null) {
                                webView.evaluateJavascript(
                                    "window.dispatchEvent(new Event('online'));", null);
                            }
                        });
                    }

                    @Override
                    public void onLost(Network network) {
                        mainHandler.post(() -> {
                            Log.d(TAG, "Network lost: notifying WebView");
                            if (webView != null) {
                                webView.evaluateJavascript(
                                    "window.dispatchEvent(new Event('offline'));", null);
                            }
                        });
                    }
                };
                connectivityManager.registerDefaultNetworkCallback(networkCallback);
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not register network callback: " + e.getMessage());
        }
    }

    private void registerNativeMediaBridge() {
        // Lock screen / notification / headset controls drive the WebView player.
        FraudioMediaBrowserService.setWebCommandListener((action, value) ->
            mainHandler.post(() -> {
                if (webView == null) return;
                try {
                    String js = "window.fraudioNativeCommand && window.fraudioNativeCommand('"
                        + action + "'," + value + ")";
                    webView.evaluateJavascript(js, null);
                } catch (Exception e) {
                    Log.w(TAG, "Failed to deliver native command to WebView", e);
                }
            }));
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(
                        new String[]{Manifest.permission.POST_NOTIFICATIONS}, 42);
                }
            } catch (Exception ignored) {
            }
        }
    }

    private void deliverWebState(String json) {
        try {
            JSONObject obj = new JSONObject(json);
            boolean stop = obj.optBoolean("stop", false);
            boolean playing = obj.optBoolean("playing", false);
            boolean running = FraudioMediaBrowserService.isRunning();

            if (stop && !running) return;
            if (!running && !playing) return;

            Intent intent = new Intent(this, FraudioMediaBrowserService.class);
            intent.setAction(FraudioMediaBrowserService.ACTION_WEB_STATE);
            intent.putExtra(FraudioMediaBrowserService.EXTRA_WEB_STATE, json);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent);
            } else {
                startService(intent);
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not deliver playback state to service", e);
        }
    }

    private final class FraudioBridge {
        @JavascriptInterface
        public void updateState(String json) {
            if (json == null || json.isEmpty()) return;
            final String payload = json;
            mainHandler.post(() -> deliverWebState(payload));
        }
    }

    private boolean hasContentLoaded() {
        if (webView == null) return false;
        String currentUrl = webView.getUrl();
        return currentUrl != null && !currentUrl.isEmpty() && !currentUrl.equals("about:blank");
    }

    private void connectToCloud() {
        isOfflineMode = false;
        String currentUrl = webView.getUrl();
        if (currentUrl != null && currentUrl.startsWith(CLOUD_URL) && !currentUrl.contains("/offline.html")) {
            return;
        }

        WebSettings settings = webView.getSettings();
        if (settings != null) {
            settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        }

        webView.loadUrl(CLOUD_URL + "/");
        webView.requestFocus();
    }

    private void launchOfflineMode() {
        try {
            isOfflineMode = true;
            String currentUrl = webView.getUrl();
            if (currentUrl != null && currentUrl.contains("/offline.html")) {
                return;
            }

            WebSettings settings = webView.getSettings();
            if (settings != null) {
                settings.setCacheMode(WebSettings.LOAD_DEFAULT);
            }

            webView.clearHistory();
            webView.loadUrl(CLOUD_URL + "/offline.html");
            webView.requestFocus();
            Toast.makeText(this, "Offline Mode: Playing cached music", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Log.e(TAG, "Error in launchOfflineMode", e);
        }
    }

    private void hideSystemUI() {
        View decorView = getWindow().getDecorView();
        decorView.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN);
    }

    private void showSystemUI() {
        View decorView = getWindow().getDecorView();
        decorView.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (customView != null) {
                if (customViewCallback != null) {
                    customViewCallback.onCustomViewHidden();
                }
                return true;
            }
            if (webView != null && webView.canGoBack()) {
                webView.goBack();
                return true;
            }
            long now = System.currentTimeMillis();
            if (now - lastBackPressTime < 2000) {
                finish();
            } else {
                lastBackPressTime = now;
                Toast.makeText(this, "Press BACK again to exit", Toast.LENGTH_SHORT).show();
            }
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        FraudioMediaBrowserService.setWebCommandListener(null);
        if (connectivityManager != null && networkCallback != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                connectivityManager.unregisterNetworkCallback(networkCallback);
            } catch (Exception ignored) {}
        }
        super.onDestroy();
    }
}
