package com.parriauxmaxime.coco;

import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebBackForwardList;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.BridgeWebViewClient;

// The coco server is picked at runtime (the bundled setup page stores its origin through @capacitor/preferences), so Capacitor's
// bridge never reaches its pages: everything the remote page needs from Android lives here, none of it through JavaScript.
public class MainActivity extends BridgeActivity {

    static final String FORGET = "com.parriauxmaxime.coco.FORGET";
    private static final String PREFS = "CapacitorStorage";
    private static final String SERVER = "server";
    private boolean ready = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(CocoPlugin.class);
        super.onCreate(savedInstanceState);
        WebView web = bridge.getWebView();
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        CookieManager.getInstance().setAcceptCookie(true);
        bridge.setWebViewClient(new CocoClient(bridge));
        web.setWebChromeClient(new CocoChrome(bridge));
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                back();
            }
        });
        if (savedInstanceState == null) open(getIntent());
        ready = true;
    }

    // BridgeActivity calls this from onCreate too, before the clients above are set
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (ready && FORGET.equals(intent.getAction())) open(intent);
    }

    @Override
    public void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    private void open(Intent intent) {
        if (FORGET.equals(intent.getAction())) {
            prefs().edit().remove(SERVER).apply();
            CookieManager.getInstance().removeAllCookies(null);
            setup("");
            return;
        }
        String server = server();
        if (server != null) bridge.getWebView().loadUrl(server + "/");
    }

    // history.back() within coco, or from a failed pairing back to the setup page; the setup page itself and coco's first page leave
    // (the setup page drops out of the history once coco shows)
    private void back() {
        WebView web = bridge.getWebView();
        WebBackForwardList list = web.copyBackForwardList();
        int i = list.getCurrentIndex();
        Uri prev = i > 0 ? Uri.parse(list.getItemAtIndex(i - 1).getUrl()) : null;
        Uri here = web.getUrl() == null ? null : Uri.parse(web.getUrl());
        if (prev != null && isServer(here) && (isServer(prev) || isLocal(prev))) web.goBack();
        else finish();
    }

    private boolean isLocal(Uri url) {
        return url != null && Uri.parse(bridge.getLocalUrl()).getHost().equals(url.getHost());
    }

    private void setup(String query) {
        bridge.getWebView().loadUrl(bridge.getLocalUrl() + "/" + query);
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private String server() {
        String s = prefs().getString(SERVER, null);
        return s == null || s.isEmpty() ? null : s;
    }

    boolean isServer(Uri url) {
        String server = server();
        if (server == null || url == null || url.getHost() == null) return false;
        Uri s = Uri.parse(server);
        return url.getHost().equalsIgnoreCase(s.getHost()) && "https".equals(url.getScheme()) && url.getPort() == s.getPort();
    }

    private class CocoClient extends BridgeWebViewClient {

        CocoClient(Bridge bridge) {
            super(bridge);
        }

        // coco's own pages stay in the app; Capacitor sends any other host to the browser
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return !isServer(request.getUrl()) && super.shouldOverrideUrlLoading(view, request);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            Uri u = Uri.parse(url);
            if (isServer(u) && !"/pair".equals(u.getPath())) view.clearHistory();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request.isForMainFrame() && isServer(request.getUrl())) setup("?offline=1");
        }

        // a revoked or unknown device: back to the setup page to scan a new code
        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            super.onReceivedHttpError(view, request, response);
            if (request.isForMainFrame() && isServer(request.getUrl()) && response.getStatusCode() == 401) setup("?unpaired=1");
        }
    }

    // the microphone (dictation) and camera for coco's pages and the setup page only; Capacitor asks Android for the permission
    private class CocoChrome extends BridgeWebChromeClient {

        CocoChrome(Bridge bridge) {
            super(bridge);
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            Uri origin = request.getOrigin();
            if (isServer(origin) || isLocal(origin)) super.onPermissionRequest(request);
            else request.deny();
        }
    }
}
