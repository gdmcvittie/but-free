package online.butfree.freeplay;

import android.app.Activity;
import android.content.Context;
import android.hardware.input.InputManager;
import android.graphics.Color;
import android.hardware.input.InputManager.InputDeviceListener;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.MimeTypeMap;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

public class MainActivity extends Activity {
    private static final String TAG = "FreeplayAndroid";
    private static final String CLOUD_URL = "https://games.butfree.online";

    private WebView webView;
    private ProgressBar progressBar;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private InputManager inputManager;
    private InputDeviceListener inputDeviceListener;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile boolean offlineMode = false;
    private long lastBackPress = 0;
    private FrameLayout fullscreenContainer;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_main);
        webView = findViewById(R.id.webview);
        progressBar = findViewById(R.id.webview_progress);
        webView.addJavascriptInterface(new FreeplayBridge(), "FreeplayAndroid");
        configureWebView();
        registerNetworkCallback();
        registerInputDeviceListener();

        if (hasInternet()) {
            openCloud();
        } else {
            openOfflineLibrary();
        }
    }

    private final class FreeplayBridge {
        @JavascriptInterface
        public boolean hasController() {
            return hasConnectedController();
        }

        @JavascriptInterface
        public void setImmersiveMode(boolean immersive) {
            mainHandler.post(() -> {
                if (immersive) hideSystemUi();
                else showSystemUi();
            });
        }
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUserAgentString(settings.getUserAgentString() + " FREEPLAY-Android");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (request == null || request.getUrl() == null) return super.shouldInterceptRequest(view, request);
                Uri uri = request.getUrl();
                if (!"games.butfree.online".equalsIgnoreCase(uri.getHost())) {
                    return super.shouldInterceptRequest(view, request);
                }

                String requestPath = uri.getPath() == null ? "/" : uri.getPath();
                if (requestPath.startsWith("/cores/")) {
                    return assetResponse(requestPath.substring(1));
                }
                if (offlineMode) {
                    if ("/offline.html".equals(requestPath) || "/".equals(requestPath)) {
                        return offlineIndexResponse();
                    }
                    if (requestPath.startsWith("/assets/")) {
                        return assetResponse("offline-site" + requestPath);
                    }
                    if ("/favicon.svg".equals(requestPath)) {
                        return assetResponse("offline-site/favicon.svg");
                    }
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request != null && request.isForMainFrame() && hasInternet() && !offlineMode) {
                    mainHandler.post(() -> openOfflineLibrary());
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int progress) {
                progressBar.setVisibility(progress < 100 ? View.VISIBLE : View.GONE);
                progressBar.setProgress(progress);
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                if (fullscreenContainer == null) {
                    fullscreenContainer = new FrameLayout(MainActivity.this);
                    fullscreenContainer.setBackgroundColor(Color.BLACK);
                }
                if (view.getParent() instanceof ViewGroup) {
                    ((ViewGroup) view.getParent()).removeView(view);
                }
                fullscreenContainer.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                ((FrameLayout) findViewById(android.R.id.content)).addView(fullscreenContainer,
                        new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                webView.setVisibility(View.GONE);
                hideSystemUi();
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                ((FrameLayout) findViewById(android.R.id.content)).removeView(fullscreenContainer);
                fullscreenContainer.removeAllViews();
                webView.setVisibility(View.VISIBLE);
                showSystemUi();
                customView = null;
                if (customViewCallback != null) {
                    customViewCallback.onCustomViewHidden();
                    customViewCallback = null;
                }
            }
        });
    }

    private WebResourceResponse offlineIndexResponse() {
        try {
            InputStream input = getAssets().open("offline-site/index.html");
            byte[] bytes = new byte[input.available()];
            int length = input.read(bytes);
            input.close();
            String html = new String(bytes, 0, Math.max(0, length), StandardCharsets.UTF_8);
            html = html.replace("<head>", "<head><script>window.FREEPLAY_ANDROID_OFFLINE=true;</script>");
            return response("text/html", "UTF-8", html.getBytes(StandardCharsets.UTF_8));
        } catch (Exception error) {
            Log.e(TAG, "Could not load bundled offline app", error);
            String fallback = "<!doctype html><meta name='viewport' content='width=device-width'><body style='background:#070a12;color:white;font:16px sans-serif;padding:2rem'><h2>FREEPLAY offline library unavailable</h2><p>Connect to the internet once to load the app and sync your games.</p></body>";
            return response("text/html", "UTF-8", fallback.getBytes(StandardCharsets.UTF_8));
        }
    }

    private WebResourceResponse assetResponse(String assetPath) {
        try {
            InputStream input = getAssets().open(assetPath);
            String extension = "";
            int dot = assetPath.lastIndexOf('.');
            if (dot >= 0) extension = assetPath.substring(dot + 1).toLowerCase();
            String mime = "wasm".equals(extension) ? "application/wasm"
                    : "js".equals(extension) || "mjs".equals(extension) ? "application/javascript"
                    : "zip".equals(extension) ? "application/zip"
                    : MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
            if (mime == null) mime = "application/octet-stream";
            WebResourceResponse result = new WebResourceResponse(mime, null, input);
            result.setResponseHeaders(Collections.singletonMap("Cache-Control", "public, max-age=31536000, immutable"));
            return result;
        } catch (Exception error) {
            return null;
        }
    }

    private WebResourceResponse response(String mime, String encoding, byte[] bytes) {
        return new WebResourceResponse(mime, encoding, new ByteArrayInputStream(bytes));
    }

    private boolean hasInternet() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Network active = cm.getActiveNetwork();
                NetworkCapabilities capabilities = active == null ? null : cm.getNetworkCapabilities(active);
                return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            }
            android.net.NetworkInfo info = cm.getActiveNetworkInfo();
            return info != null && info.isConnected();
        } catch (Exception ignored) {
            return false;
        }
    }

    private void registerNetworkCallback() {
        try {
            connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (connectivityManager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    mainHandler.post(() -> {
                        if (offlineMode || webView.getUrl() == null) openCloud();
                        webView.evaluateJavascript("window.dispatchEvent(new Event('online'))", null);
                    });
                }

                @Override
                public void onLost(Network network) {
                    mainHandler.post(() -> webView.evaluateJavascript("window.dispatchEvent(new Event('offline'))", null));
                }
            };
            connectivityManager.registerDefaultNetworkCallback(networkCallback);
        } catch (Exception error) {
            Log.w(TAG, "Network callback unavailable", error);
        }
    }

    private void registerInputDeviceListener() {
        try {
            inputManager = (InputManager) getSystemService(Context.INPUT_SERVICE);
            if (inputManager == null) return;
            inputDeviceListener = new InputDeviceListener() {
                @Override public void onInputDeviceAdded(int deviceId) { notifyControllerChange(); }
                @Override public void onInputDeviceRemoved(int deviceId) { notifyControllerChange(); }
                @Override public void onInputDeviceChanged(int deviceId) { notifyControllerChange(); }
            };
            inputManager.registerInputDeviceListener(inputDeviceListener, mainHandler);
        } catch (Exception error) {
            Log.w(TAG, "Could not observe Android game controllers", error);
        }
    }

    private boolean hasConnectedController() {
        try {
            for (int deviceId : InputDevice.getDeviceIds()) {
                InputDevice device = InputDevice.getDevice(deviceId);
                if (device != null && isControllerSource(device.getSources())) return true;
            }
        } catch (Exception error) {
            Log.w(TAG, "Could not inspect Android input devices", error);
        }
        return false;
    }

    private boolean isControllerSource(int sources) {
        return (sources & InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD
                || (sources & InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK;
    }

    private void notifyControllerChange() {
        if (webView == null) return;
        boolean connected = hasConnectedController();
        String script = "window.dispatchEvent(new CustomEvent('freeplay:controllerchange',{detail:{connected:"
                + connected + "}}));";
        webView.evaluateJavascript(script, null);
    }

    private String[] mapControllerKey(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_DPAD_UP: return new String[] {"ArrowUp", "ArrowUp", "38"};
            case KeyEvent.KEYCODE_DPAD_DOWN: return new String[] {"ArrowDown", "ArrowDown", "40"};
            case KeyEvent.KEYCODE_DPAD_LEFT: return new String[] {"ArrowLeft", "ArrowLeft", "37"};
            case KeyEvent.KEYCODE_DPAD_RIGHT: return new String[] {"ArrowRight", "ArrowRight", "39"};
            case KeyEvent.KEYCODE_BUTTON_A: return new String[] {"x", "KeyX", "88"};
            case KeyEvent.KEYCODE_BUTTON_B: return new String[] {"z", "KeyZ", "90"};
            case KeyEvent.KEYCODE_BUTTON_X: return new String[] {"s", "KeyS", "83"};
            case KeyEvent.KEYCODE_BUTTON_Y: return new String[] {"a", "KeyA", "65"};
            case KeyEvent.KEYCODE_BUTTON_L1: return new String[] {"q", "KeyQ", "81"};
            case KeyEvent.KEYCODE_BUTTON_R1: return new String[] {"w", "KeyW", "87"};
            case KeyEvent.KEYCODE_BUTTON_SELECT: return new String[] {"Shift", "ShiftLeft", "16"};
            case KeyEvent.KEYCODE_BUTTON_START: return new String[] {"Enter", "Enter", "13"};
            default: return null;
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (webView != null && event != null
                && (event.getAction() == KeyEvent.ACTION_DOWN || event.getAction() == KeyEvent.ACTION_UP)) {
            InputDevice device = event.getDevice();
            int sources = event.getSource() | (device == null ? 0 : device.getSources());
            String[] mapped = mapControllerKey(event.getKeyCode());
            if (mapped != null && isControllerSource(sources)) {
                String action = event.getAction() == KeyEvent.ACTION_DOWN ? "keydown" : "keyup";
                String script = "window.__freeplayAndroidKey&&window.__freeplayAndroidKey('" + action
                        + "','" + mapped[0] + "','" + mapped[1] + "'," + mapped[2] + ");";
                webView.evaluateJavascript(script, null);
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    private void openCloud() {
        offlineMode = false;
        webView.getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
        webView.loadUrl(CLOUD_URL + "/");
    }

    private void openOfflineLibrary() {
        offlineMode = true;
        webView.getSettings().setCacheMode(WebSettings.LOAD_CACHE_ELSE_NETWORK);
        webView.clearHistory();
        webView.loadUrl(CLOUD_URL + "/offline.html");
        Toast.makeText(this, "Offline library: downloaded games only", Toast.LENGTH_SHORT).show();
    }

    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN);
    }

    private void showSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            if (customViewCallback != null) customViewCallback.onCustomViewHidden();
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackPress < 2000) super.onBackPressed();
        else {
            lastBackPress = now;
            Toast.makeText(this, "Press BACK again to exit", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onDestroy() {
        if (connectivityManager != null && networkCallback != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try { connectivityManager.unregisterNetworkCallback(networkCallback); } catch (Exception ignored) { }
        }
        if (inputManager != null && inputDeviceListener != null) {
            try { inputManager.unregisterInputDeviceListener(inputDeviceListener); } catch (Exception ignored) { }
        }
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
