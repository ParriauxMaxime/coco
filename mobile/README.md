# coco for Android

A Capacitor app (`com.parriauxmaxime.coco`) that shows the coco of your Mac on
an Android phone, through Tailscale. The server's address is never built in:
the first launch shows a bundled setup page that scans the pairing QR from
coco Settings > Devices (or takes the pasted link), keeps the server's origin
(`@capacitor/preferences`, key `server`) and opens the link, which sets the
device cookie. Later launches open the server directly. Server side setup:
the Phone section of [docs/configuration.md](../docs/configuration.md).

## Build

```sh
brew install openjdk@21
brew install --cask android-commandlinetools
sdkmanager --sdk_root=/opt/homebrew/share/android-commandlinetools --licenses
sdkmanager --sdk_root=/opt/homebrew/share/android-commandlinetools "platform-tools" "platforms;android-36" "build-tools;36.0.0"
cd mobile && npm install && npm run apk
```

`npm run apk` syncs the web assets and plugins (`cap sync android`), builds a
debug-signed APK (Android's debug key in `~/.android/debug.keystore`; keep
the same Mac to install updates over it) and copies it to `dist/coco.apk`.
coco serves that file to paired devices at `/mobile/coco.apk`. `JAVA_HOME`
and `ANDROID_HOME` default to the Homebrew paths above.

## On the phone

- Back: goes back in coco's history; at its first page it leaves the app.
- Long-press the app icon > Change server: forgets the server and its cookie,
  back to the setup page. A revoked device lands there too, to scan a new
  code; so does a server that does not answer, with a retry.
- The microphone (dictation) and camera are granted to the paired server's
  pages and the setup page only, after Android's own permission prompt.
- Edge to edge: Capacitor's SystemBars pads the WebView with the system bars'
  insets (or passes them to the page as `env(safe-area-inset-*)` and
  `--safe-area-inset-*` when it declares `viewport-fit=cover`); the bars
  follow the system's light or dark mode over coco's background color.

## Why the remote page gets no Capacitor bridge

Capacitor 8 on Android injects its JavaScript bridge with
`WebViewCompat.addDocumentStartJavaScript` for the app's own origin only
(`https://localhost`), and accepts bridge messages (`addWebMessageListener`)
from that origin, `server.url` and the `server.allowNavigation` hosts, all read
from `capacitor.config.json` at build time. A coco server picked at runtime
is none of these: its pages have no `window.Capacitor` and no plugins, even
under an `allowNavigation` wildcard such as `*.ts.net` (that would only let
the WebView navigate there instead of handing the link to the browser, and
open the message channel without the script that uses it). So the app does
not rely on the bridge outside its setup page:

- `MainActivity` keeps the paired server's pages in the WebView (its
  `shouldOverrideUrlLoading` allows that one https origin, anything else goes
  to the browser as Capacitor does), handles the back button, sends a 401 or
  an unreachable server back to the setup page, grants the microphone to
  that origin only, flushes cookies when paused and disables overscroll.
- The setup page uses the bridge (it is bundled) to call Preferences, the
  barcode scanner and a small `Coco.open` plugin: the WebView then loads the
  server itself, a navigation with no initiator, so the SameSite=Strict
  device cookie goes along (a link followed from `https://localhost` would be
  cross-site and leave it out). `/pair` also goes on to coco through a page
  of its own origin rather than a redirect, for the same reason.

The barcode scanner is `@capacitor/barcode-scanner` (ML Kit bundled, no Google
Play services needed); it accounts for most of the APK's size.
