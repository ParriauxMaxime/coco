package com.parriauxmaxime.coco;

import android.net.Uri;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Coco.open({ url }) from the setup page: the WebView loads the server's page itself, a navigation with no initiator, so the
// SameSite=Strict device cookie goes along (a link followed from https://localhost would be cross-site and leave it out)
@CapacitorPlugin(name = "Coco")
public class CocoPlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url", "");
        MainActivity activity = (MainActivity) getActivity();
        if (!activity.isServer(Uri.parse(url))) {
            call.reject("not the coco server this app is paired with");
            return;
        }
        getBridge().executeOnMainThread(() -> getBridge().getWebView().loadUrl(url));
        call.resolve();
    }
}
