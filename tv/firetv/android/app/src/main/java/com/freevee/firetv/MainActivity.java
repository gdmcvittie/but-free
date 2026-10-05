package com.freevee.firetv;

import android.app.Activity;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);

        // Configure WebView settings to allow cross-origin and local asset execution
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccess(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // Enable Remote Web Debugging (allows debugging via chrome://inspect)
        WebView.setWebContentsDebuggingEnabled(true);

        // Keep focusable settings
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);

        // Intercept http://appassets.androidplatform.net requests and serve them offline from the APK assets folder
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                android.net.Uri uri = request.getUrl();
                String urlString = uri.toString();

                if (urlString.contains("appassets.androidplatform.net")) {
                    String path = uri.getPath();
                    if (path != null) {
                        String assetPath = path;
                        if (assetPath.startsWith("/")) {
                            assetPath = assetPath.substring(1);
                        }
                        // Strip prefix if any since assets are copied directly to the root assets folder of the APK
                        if (assetPath.startsWith("firetv-cloud/")) {
                            assetPath = assetPath.substring(13);
                        } else if (assetPath.startsWith("freevee/")) {
                            assetPath = assetPath.substring(8);
                        } else if (assetPath.startsWith("firetv/")) {
                            assetPath = assetPath.substring(7);
                        }

                        try {
                            // Read the asset directly from the APK's assets
                            InputStream stream = getAssets().open(assetPath);

                            // Map extensions to MIME types
                            String mimeType = "text/html";
                            if (assetPath.endsWith(".js")) {
                                mimeType = "application/javascript";
                            } else if (assetPath.endsWith(".css")) {
                                mimeType = "text/css";
                            } else if (assetPath.endsWith(".png")) {
                                mimeType = "image/png";
                            } else if (assetPath.endsWith(".jpg") || assetPath.endsWith(".jpeg")) {
                                mimeType = "image/jpeg";
                            } else if (assetPath.endsWith(".ico")) {
                                mimeType = "image/x-icon";
                            } else if (assetPath.endsWith(".svg")) {
                                mimeType = "image/svg+xml";
                            }

                            Map<String, String> responseHeaders = new HashMap<>();
                            responseHeaders.put("Access-Control-Allow-Origin", "*");

                            return new WebResourceResponse(
                                mimeType,
                                "UTF-8",
                                200,
                                "OK",
                                responseHeaders,
                                stream
                            );
                        } catch (Exception e) {
                            android.util.Log.e("FREEVEEProxy", "Failed to load local asset: " + assetPath, e);
                            return new WebResourceResponse(
                                "text/plain",
                                "UTF-8",
                                404,
                                "Not Found",
                                new HashMap<String, String>(),
                                new java.io.ByteArrayInputStream(("File Not Found: " + assetPath).getBytes())
                            );
                        }
                    }
                }

                return super.shouldInterceptRequest(view, request);
            }
        });

        // Load the local React application over custom HTTP scheme to prevent CORS & Mixed Content
        webView.loadUrl("http://appassets.androidplatform.net/firetv-cloud/index.html");
        webView.requestFocus();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
