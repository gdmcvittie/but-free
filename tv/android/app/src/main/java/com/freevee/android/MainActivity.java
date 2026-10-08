package com.freevee.android;

import android.app.Activity;
import android.content.Context;
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

import java.io.InputStream;

public class MainActivity extends Activity {

    private static final String TAG = "FreeveeAndroid";
    public static final String CLOUD_URL = "https://tv.butfree.online";

    public static final String PREFS_NAME = "freevee_prefs";
    public static final String KEY_MODE = "mode";
    public static final String MODE_CLOUD = "cloud";
    public static final String MODE_LOCAL = "local";
    public static final String KEY_SERVER_IP = "server_ip";
    public static final int SERVER_PORT = 3001;

    private WebView webView;
    private ProgressBar webViewProgress;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private boolean isOfflineMode = false;
    private long lastBackPressTime = 0;

    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;

    // Fullscreen video playback support
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

        if (isNetworkAvailable()) {
            connectToCloud();
        } else {
            launchOfflineMode();
        }
    }

    private void initWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() + " FREEVEE-Android");
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccess(true);

        // Viewport and responsive scaling
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        WebView.setWebContentsDebuggingEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);

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
                            Log.e(TAG, "Failed to load bundled offline video player asset", e);
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
                            Log.d(TAG, "Internet connectivity restored");
                            if (isOfflineMode || !hasContentLoaded()) {
                                connectToCloud();
                            }
                            if (webView != null) {
                                webView.evaluateJavascript("window.dispatchEvent(new Event('online'));", null);
                            }
                        });
                    }

                    @Override
                    public void onLost(Network network) {
                        mainHandler.post(() -> {
                            Log.d(TAG, "Internet connectivity lost");
                            if (webView != null) {
                                webView.evaluateJavascript("window.dispatchEvent(new Event('offline'));", null);
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
            Toast.makeText(this, "Offline Mode: Playing saved videos", Toast.LENGTH_SHORT).show();
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
    public void onBackPressed() {
        if (customView != null) {
            if (customViewCallback != null) {
                customViewCallback.onCustomViewHidden();
            }
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackPressTime < 2000) {
            super.onBackPressed();
        } else {
            lastBackPressTime = now;
            Toast.makeText(this, "Press BACK again to exit", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onDestroy() {
        if (connectivityManager != null && networkCallback != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                connectivityManager.unregisterNetworkCallback(networkCallback);
            } catch (Exception ignored) {}
        }
        super.onDestroy();
    }
}
