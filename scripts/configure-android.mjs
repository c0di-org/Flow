import fs from 'node:fs';
import path from 'node:path';

const manifest = path.resolve('src-tauri/gen/android/app/src/main/AndroidManifest.xml');
if (!fs.existsSync(manifest)) {
  console.log('Android project not initialized yet; run npm run android:init when the Android toolchain is installed.');
  process.exit(0);
}

let source = fs.readFileSync(manifest, 'utf8');

function setApplicationAttribute(name, value) {
  const pattern = new RegExp(`\s+android:${name}=\"[^\"]*\"`);
  if (pattern.test(source)) {
    source = source.replace(pattern, ` android:${name}="${value}"`);
  } else {
    source = source.replace(/<application\b/, `<application android:${name}="${value}"`);
  }
}

setApplicationAttribute('resizeableActivity', 'true');
setApplicationAttribute('hardwareAccelerated', 'true');

// Fixed activity orientation fights DeX freeform resizing and tablet rotation.
// Flow is adaptive, so remove any template/plugin orientation lock.
source = source.replace(/\s+android:screenOrientation="[^"]*"/g, '');

if (!source.includes('android.supports_size_changes')) {
  source = source.replace(
    /<application[^>]*>/,
    (match) => `${match}\n        <meta-data android:name="android.supports_size_changes" android:value="true" />`,
  );
}

fs.writeFileSync(manifest, source);
console.log('Android large-screen / DeX manifest flags are configured.');
