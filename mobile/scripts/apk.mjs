// The debug-signed APK: gradle assembleDebug, then a copy at dist/coco.apk, which coco serves to paired devices at /mobile/coco.apk.
// JAVA_HOME and ANDROID_HOME default to Homebrew's openjdk@21 and android-commandlinetools.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(MOBILE, 'android');
const OUT = path.join(MOBILE, 'dist', 'coco.apk');
const BREW = {
  JAVA_HOME: ['/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home', 'brew install openjdk@21'],
  ANDROID_HOME: ['/opt/homebrew/share/android-commandlinetools', 'brew install --cask android-commandlinetools, then sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"'],
};

const env = { ...process.env };
for (const [name, [dir, install]] of Object.entries(BREW)) {
  env[name] ||= fs.existsSync(dir) ? dir : '';
  if (!env[name]) {
    console.error(`apk: set ${name}, or install it: ${install}`);
    process.exit(1);
  }
}
execFileSync('./gradlew', ['assembleDebug', '--console=plain', '-q'], { cwd: ANDROID, env, stdio: 'inherit' });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.copyFileSync(path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'), OUT);
console.log(`apk: ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
