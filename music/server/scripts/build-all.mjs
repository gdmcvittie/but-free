import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

console.log('=== [1/3] Building Android Mobile App APK ===');
const buildBat = path.resolve('mobile-client/build.bat');
if (fs.existsSync(buildBat)) {
  const res = spawnSync('cmd.exe', ['/c', 'build.bat'], {
    cwd: path.resolve('mobile-client'),
    stdio: 'inherit'
  });
  if (res.status !== 0) {
    console.warn(`[WARN] Android build exited with status ${res.status}. Continuing web build...`);
  }
} else {
  console.log('[SKIP] mobile-client/build.bat not found.');
}

console.log('\n=== [2/3] Syncing fraudio.apk to public/ ===');
const apkSrc = path.resolve('mobile-client/app/build/outputs/apk/debug/app-debug.apk');
const apkDest = path.resolve('public/fraudio.apk');
if (fs.existsSync(apkSrc)) {
  fs.mkdirSync(path.resolve('public'), { recursive: true });
  fs.copyFileSync(apkSrc, apkDest);
  const sizeMB = (fs.statSync(apkDest).size / (1024 * 1024)).toFixed(2);
  console.log(`[SUCCESS] Copied ${sizeMB} MB APK to public/fraudio.apk`);
} else {
  console.log('[INFO] No APK output found yet at ' + apkSrc);
}

console.log('\n=== [3/3] Building Web Production Bundle (vite build) ===');
const viteRes = spawnSync('npx vite build', {
  stdio: 'inherit',
  shell: true
});

if (viteRes.error) {
  console.error('[ERROR] Failed to run vite build:', viteRes.error);
  process.exit(1);
}

if (viteRes.status !== 0) {
  process.exit(viteRes.status || 1);
}

// Ensure fraudio.apk is also in dist/ if available
const distApk = path.resolve('dist/fraudio.apk');
if (fs.existsSync(apkDest) && !fs.existsSync(distApk)) {
  fs.copyFileSync(apkDest, distApk);
}
console.log('=== Build All Complete ===');
