#!/usr/bin/env node
/**
 * Cloud-server build orchestrator.
 *
 * Steps:
 *   1. Build the Android APK by running mobile-client/build.bat (waits for completion).
 *   2. Copy the resulting APK into public/comix.apk so it ships inside dist/.
 *   3. Build the cloud-server frontend (vite build), which copies public/* into dist/.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const repoRoot = path.join(__dirname, '..', '..');
const mobileClientDir = path.join(repoRoot, 'mobile-client');
const buildBat = path.join(mobileClientDir, 'build.bat');
const apkSource = path.join(mobileClientDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const publicDir = path.join(rootDir, 'public');
const apkDest = path.join(publicDir, 'comix.apk');
const viteBin = path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js');

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd || rootDir, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`"${cmd} ${args.join(' ')}" exited with code ${code}`));
    });
  });
}

async function main() {
  // 1. Build the APK (Windows-only local build).
  console.log('[build] [1/3] Building Android APK via mobile-client/build.bat...');
  if (process.platform === 'win32' && fs.existsSync(buildBat)) {
    const comspec = process.env.ComSpec || 'cmd.exe';
    await run(comspec, ['/d', '/s', '/c', buildBat], { cwd: mobileClientDir });
  } else {
    // Entry point for a platform without the .bat toolchain: keep any pre-built APK.
    console.log('[build] [1/3] Skipping APK build (build.bat requires Windows). Using existing comix.apk if present.');
  }

  if (fs.existsSync(apkSource)) {
    console.log('[build] [2/3] Copying APK -> public/comix.apk (' + (fs.statSync(apkSource).size / 1024 / 1024).toFixed(1) + ' MB)');
    fs.mkdirSync(publicDir, { recursive: true });
    fs.copyFileSync(apkSource, apkDest);
  } else {
    console.warn('[build] [2/3] WARNING: APK not found at ' + apkSource + '. Skipping comix.apk (build will still continue).');
    if (fs.existsSync(apkDest)) fs.unlinkSync(apkDest);
  }

  // 3. Build the cloud-server frontend.
  console.log('[build] [3/3] Building cloud-server frontend (vite build)...');
  if (!fs.existsSync(viteBin)) {
    throw new Error('vite not found in node_modules. Run `npm install` first.');
  }
  await run(process.execPath, [viteBin, 'build'], { cwd: rootDir });

  console.log('[build] Done. dist/ now contains the frontend and comix.apk.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[build] FAILED:', err.message);
    process.exit(1);
  });