import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const distRoot = path.join(root, 'dist');

console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log('║        butfree.online - Unified Master Monorepo Builder         ║');
console.log('╚══════════════════════════════════════════════════════════════════╝');
console.log(`[Target Directory] All compiled files will be output to: ${distRoot}\n`);

// Load root shared .env for all sub-apps
const rootEnvPath = path.join(root, '.env');
let parsedEnv = {};
if (fs.existsSync(rootEnvPath)) {
  try {
    parsedEnv = dotenv.parse(fs.readFileSync(rootEnvPath));
    dotenv.config({ path: rootEnvPath });
    console.log(`[Env] Using shared root environment: ${rootEnvPath}`);
  } catch (err) {
    console.warn(`[WARN] Could not parse root .env:`, err.message);
  }
}

// Ensure dist and dist/apks exist
const apksDistDir = path.join(distRoot, 'apks');
fs.mkdirSync(apksDistDir, { recursive: true });

const toolchainDir = fs.existsSync(path.join(root, 'toolchain'))
  ? path.join(root, 'toolchain')
  : 'C:\\_code\\___MY-TV\\my-tv\\toolchain';

console.log(`[Toolchain] Toolchain location: ${toolchainDir}`);
const jdkDir = path.join(toolchainDir, 'jdk');
const sdkDir = path.join(toolchainDir, 'android-sdk');
const gradleBat = path.join(toolchainDir, 'gradle', 'bin', 'gradle.bat');

function runCommand(cmd, args, cwd) {
  console.log(`> [${cwd}] ${cmd} ${args.join(' ')}`);
  const isWin = process.platform === 'win32';
  const effectiveCmd = isWin && cmd.endsWith('.bat') ? 'cmd.exe' : cmd;
  const effectiveArgs = isWin && cmd.endsWith('.bat') ? ['/c', cmd, ...args] : args;

  const res = spawnSync(effectiveCmd, effectiveArgs, {
    cwd,
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      ...parsedEnv,
      TOOLCHAIN: toolchainDir,
      JAVA_HOME: jdkDir,
      ANDROID_HOME: sdkDir,
      ANDROID_SDK_ROOT: sdkDir,
      PATH: `${path.join(jdkDir, 'bin')};${process.env.PATH}`
    }
  });

  return res.status === 0;
}

function copyClean(src, dst, exclude = []) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (exclude.includes(entry.name)) continue;
    if (['node_modules', '.git', '.gradle', 'build', '.idea', '.vscode'].includes(entry.name)) continue;
    if (entry.name.endsWith('.log') || entry.name.endsWith('.hprof')) continue;

    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);

    if (entry.isDirectory()) {
      copyClean(srcPath, dstPath, exclude);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

const onlyArg = process.argv.find(a => a.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1].toLowerCase() : null;
if (only) {
  console.log(`[Target Filter] Running selective build for: ${only}\n`);
}

const welcomeDist = path.join(distRoot, 'welcome');
const comicsDist = path.join(distRoot, 'comics');
const musicDist = path.join(distRoot, 'music');
const tvDist = path.join(distRoot, 'tv');
const gamesDist = path.join(distRoot, 'games');
const downloaderDist = path.join(distRoot, 'downloader');

// -----------------------------------------------------------------------------
// 0. Build Welcome Landing Page -> dist/welcome
// -----------------------------------------------------------------------------
if (!only || only === 'welcome') {
  console.log('\n==================================================================');
  console.log(' [0/4] Compiling WELCOME LANDING PAGE (butfree.online)');
  console.log('==================================================================');
  const welcomeSrc = path.join(root, 'welcome');
  if (fs.existsSync(welcomeSrc)) {
    copyClean(welcomeSrc, welcomeDist);
    console.log(`✓ Compiled static landing page and legal pages -> ${welcomeDist}`);
  }
}

// -----------------------------------------------------------------------------
// 1. Build Comics App: ComixoloFree -> dist/comics & dist/apks
// -----------------------------------------------------------------------------
if (!only || only === 'comics') {
  console.log('\n==================================================================');
  console.log(' [1/4] Building COMIXOLOFREE (Comics & Manga)');
  console.log('==================================================================');
  const comicsAndroidDir = path.join(root, 'comics', 'android');
  const comicsServerDir = path.join(root, 'comics', 'server');

  if (fs.existsSync(comicsAndroidDir)) {
    console.log('[Comics] Compiling Android APK via Toolchain...');
    const buildBat = path.join(comicsAndroidDir, 'build.bat');
    if (fs.existsSync(buildBat)) {
      runCommand('cmd.exe', ['/c', 'build.bat'], comicsAndroidDir);
    }
    const apkOut = path.join(comicsAndroidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
    const serverPublicApk = path.join(comicsServerDir, 'public', 'comixolofree.apk');
    
    if (fs.existsSync(apkOut)) {
      fs.mkdirSync(path.dirname(serverPublicApk), { recursive: true });
      fs.copyFileSync(apkOut, serverPublicApk);
      fs.copyFileSync(apkOut, path.join(comicsServerDir, 'public', 'comix.apk'));
      // Copy directly to dist/apks
      fs.copyFileSync(apkOut, path.join(apksDistDir, 'comixolofree.apk'));
      console.log(`✓ Bundled comixolofree.apk into comics/server/public and dist/apks/`);
    }
  }

  if (fs.existsSync(comicsServerDir)) {
    console.log('[Comics] Compiling Web App (vite build)...');
    runCommand('npx', ['vite', 'build'], comicsServerDir);

    // Copy compiled server and web dist into dist/comics
    console.log(`[Comics] Exporting to ${comicsDist}...`);
    copyClean(comicsServerDir, comicsDist, ['src', 'scratch']);

    // Ensure compiled Vite assets (index.html, assets/, manifest, icons) are also at root of dist/comics
    const comicsViteDist = path.join(comicsServerDir, 'dist');
    if (fs.existsSync(comicsViteDist)) {
      copyClean(comicsViteDist, comicsDist);
    }
    console.log(`✓ Exported comics server, backend, and web assets to ${comicsDist}`);
  }
}

// -----------------------------------------------------------------------------
// 2. Build Music App: Fraudio -> dist/music & dist/apks
// -----------------------------------------------------------------------------
if (!only || only === 'music') {
  console.log('\n==================================================================');
  console.log(' [2/4] Building FRAUDIO (Music & Audiobooks)');
  console.log('==================================================================');
  const musicAndroidDir = path.join(root, 'music', 'android');
  const musicServerDir = path.join(root, 'music', 'server');

  if (fs.existsSync(musicAndroidDir)) {
    console.log('[Music] Compiling Android APK via Toolchain...');
    const buildBat = path.join(musicAndroidDir, 'build.bat');
    if (fs.existsSync(buildBat)) {
      runCommand('cmd.exe', ['/c', 'build.bat'], musicAndroidDir);
    }
    const apkOut = path.join(musicAndroidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
    const serverPublicApk = path.join(musicServerDir, 'public', 'fraudio.apk');
    
    if (fs.existsSync(apkOut)) {
      fs.mkdirSync(path.dirname(serverPublicApk), { recursive: true });
      fs.copyFileSync(apkOut, serverPublicApk);
      // Copy directly to dist/apks
      fs.copyFileSync(apkOut, path.join(apksDistDir, 'fraudio.apk'));
      console.log(`✓ Bundled fraudio.apk into music/server/public and dist/apks/`);
    }
  }

  if (fs.existsSync(musicServerDir)) {
    console.log('[Music] Compiling Web App (vite build)...');
    runCommand('npx', ['vite', 'build'], musicServerDir);

    // Copy compiled server and web dist into dist/music
    console.log(`[Music] Exporting to ${musicDist}...`);
    copyClean(musicServerDir, musicDist, ['src', 'tests']);
    console.log(`✓ Exported music server, backend, and web assets to ${musicDist}`);
  }
}

// -----------------------------------------------------------------------------
// 3. Build TV App: Freevee -> dist/tv & dist/apks
// -----------------------------------------------------------------------------
if (!only || only === 'tv') {
  console.log('\n==================================================================');
  console.log(' [3/4] Building FREEVEE (TV, Mobile Android, FireTV, Roku)');
  console.log('==================================================================');
  const tvServerDir = path.join(root, 'tv', 'server');
  const tvAndroidDir = path.join(root, 'tv', 'android');
  const tvFireTvDir = path.join(root, 'tv', 'firetv');
  const tvRokuDir = path.join(root, 'tv', 'roku');

  // Android Mobile Client Build (Freevee Mobile APK)
  if (fs.existsSync(tvAndroidDir)) {
    console.log('[TV] Preparing Android Mobile icons and assets...');
    const tvDrawableDir = path.join(tvAndroidDir, 'app', 'src', 'main', 'res', 'drawable');
    const icon512 = path.join(tvServerDir, 'public', 'icon-512.png');
    const icon192 = path.join(tvServerDir, 'public', 'icon-192.png');
    fs.mkdirSync(tvDrawableDir, { recursive: true });
    if (fs.existsSync(icon512)) {
      fs.copyFileSync(icon512, path.join(tvDrawableDir, 'ic_launcher.png'));
      fs.copyFileSync(icon512, path.join(tvDrawableDir, 'icon_512.png'));
    }
    if (fs.existsSync(icon192)) {
      fs.copyFileSync(icon192, path.join(tvDrawableDir, 'icon_192.png'));
    }

    console.log('[TV] Compiling Android Mobile APK via Toolchain...');
    const buildBat = path.join(tvAndroidDir, 'build.bat');
    if (fs.existsSync(buildBat)) {
      runCommand('cmd.exe', ['/c', 'build.bat'], tvAndroidDir);
    }
    const apkOut = path.join(tvAndroidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
    const serverPublicApk = path.join(tvServerDir, 'public', 'freevee.apk');

    if (fs.existsSync(apkOut)) {
      fs.mkdirSync(path.dirname(serverPublicApk), { recursive: true });
      fs.copyFileSync(apkOut, serverPublicApk);
      fs.copyFileSync(apkOut, path.join(tvServerDir, 'public', 'tv.apk'));
      fs.copyFileSync(apkOut, path.join(apksDistDir, 'freevee.apk'));
      console.log(`✓ Bundled freevee.apk into tv/server/public and dist/apks/`);
    }
  }

  // FireTV Build
  if (fs.existsSync(tvFireTvDir)) {
    console.log('[TV] Syncing FREEVEE Fire TV icons and branding...');
    const icon512 = path.join(tvServerDir, 'public', 'icon-512.png');
    const icon192 = path.join(tvServerDir, 'public', 'icon-192.png');
    if (fs.existsSync(icon512)) {
      fs.copyFileSync(icon512, path.join(tvFireTvDir, 'public', '512.png'));
      const fireTvResDir = path.join(tvFireTvDir, 'android', 'app', 'src', 'main', 'res', 'drawable');
      fs.mkdirSync(fireTvResDir, { recursive: true });
      fs.copyFileSync(icon512, path.join(fireTvResDir, 'ic_launcher.png'));
    }
    if (fs.existsSync(icon192)) {
      fs.copyFileSync(icon192, path.join(tvFireTvDir, 'public', '192.png'));
    }

    console.log('[TV] Building Fire TV Web and APK...');
    runCommand('npx', ['vite', 'build'], tvFireTvDir);
    const fireTvAndroid = path.join(tvFireTvDir, 'android');
    if (fs.existsSync(fireTvAndroid)) {
      // Sync compiled web assets into APK assets directory
      const fireTvDist = path.join(tvFireTvDir, 'dist');
      const fireTvAssets = path.join(fireTvAndroid, 'app', 'src', 'main', 'assets');
      if (fs.existsSync(fireTvDist)) {
        copyClean(fireTvDist, fireTvAssets);
      }

      const fireTvBat = path.join(fireTvAndroid, 'gradlew.bat');
      if (fs.existsSync(fireTvBat)) {
        runCommand('cmd.exe', ['/c', 'gradlew.bat', 'assembleDebug'], fireTvAndroid);
      } else if (fs.existsSync(gradleBat)) {
        runCommand(gradleBat, ['assembleDebug'], fireTvAndroid);
      }
      const fireTvApk = path.join(fireTvAndroid, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
      if (fs.existsSync(fireTvApk)) {
        if (fs.existsSync(tvServerDir)) {
          const dest = path.join(tvServerDir, 'public', 'firetv.apk');
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(fireTvApk, dest);

          const tvDownloadsDir = path.join(tvServerDir, 'public', 'tv', 'downloads');
          fs.mkdirSync(tvDownloadsDir, { recursive: true });
          fs.copyFileSync(fireTvApk, path.join(tvDownloadsDir, 'firetv.apk'));
          fs.copyFileSync(fireTvApk, path.join(tvDownloadsDir, 'firetv-cloud-app.apk'));
        }
        fs.copyFileSync(fireTvApk, path.join(apksDistDir, 'firetv.apk'));
        console.log(`✓ Bundled firetv.apk to tv/server/public and dist/apks/`);
      }
    }
  }

  // Roku Build (Zip package)
  if (fs.existsSync(tvRokuDir)) {
    console.log('[TV] Syncing FREEVEE Roku channel icons...');
    const icon512 = path.join(tvServerDir, 'public', 'icon-512.png');
    const icon192 = path.join(tvServerDir, 'public', 'icon-192.png');
    const rokuImgDir = path.join(tvRokuDir, 'images');
    fs.mkdirSync(rokuImgDir, { recursive: true });
    if (fs.existsSync(icon512)) fs.copyFileSync(icon512, path.join(rokuImgDir, '512.png'));
    if (fs.existsSync(icon192)) fs.copyFileSync(icon192, path.join(rokuImgDir, '192.png'));

    console.log('[TV] Packaging Roku Channel...');
    const rokuZipPath = path.join(apksDistDir, 'roku.zip');
    try {
      const zip = new AdmZip();
      zip.addLocalFolder(tvRokuDir);
      zip.writeZip(rokuZipPath);
      if (fs.existsSync(tvServerDir)) {
        const srvRoku = path.join(tvServerDir, 'public', 'roku.zip');
        fs.mkdirSync(path.dirname(srvRoku), { recursive: true });
        fs.copyFileSync(rokuZipPath, srvRoku);

        const tvDownloadsDir = path.join(tvServerDir, 'public', 'tv', 'downloads');
        fs.mkdirSync(tvDownloadsDir, { recursive: true });
        fs.copyFileSync(rokuZipPath, path.join(tvDownloadsDir, 'roku.zip'));
        fs.copyFileSync(rokuZipPath, path.join(tvDownloadsDir, 'roku-cloud-app.zip'));
      }
      console.log(`✓ Packaged roku.zip to dist/apks/ and tv/server/public/`);
    } catch (err) {
      console.warn(`[WARN] Roku zip packaging note: ${err.message}`);
    }
  }

  // TV Server Vite Build & Export
  if (fs.existsSync(tvServerDir)) {
    console.log('[TV] Compiling Web App (vite build)...');
    runCommand('npx', ['vite', 'build'], tvServerDir);

    console.log(`[TV] Exporting to ${tvDist}...`);
    copyClean(tvServerDir, tvDist, ['src', 'tmp']);
    console.log(`✓ Exported TV server, backend, and web assets to ${tvDist}`);
  }
}

// -----------------------------------------------------------------------------
// 4. Games App: FREEPLAY -> dist/games
// -----------------------------------------------------------------------------
if (!only || only === 'games') {
  console.log('\n==================================================================');
  console.log(' [4/5] Building FREEPLAY (Cloud Retro Games)');
  console.log('==================================================================');
  const gamesServerDir = path.join(root, 'games', 'server');
  const gamesAndroidDir = path.join(root, 'games', 'android');
  const freeplayDownloaderDir = path.join(root, 'freeplay-downloader');

  // Build the Freeplay Downloader desktop app and stage its installer for the games server
  if (fs.existsSync(freeplayDownloaderDir)) {
    console.log('[Games] Building Freeplay Downloader desktop app (Electron)...');
    if (!runCommand('npm', ['run', 'build'], freeplayDownloaderDir)) {
      throw new Error('Freeplay Downloader build failed.');
    }
    const electronDist = path.join(freeplayDownloaderDir, 'dist_electron');
    const setupExe = fs.existsSync(electronDist)
      ? fs.readdirSync(electronDist)
          .filter(f => f.toLowerCase().includes('setup') && f.toLowerCase().endsWith('.exe'))
          .sort()[0]
      : null;
    if (!setupExe) {
      throw new Error(`FreeplayDownloader-Setup exe not found in ${electronDist}`);
    }
    const publicDir = path.join(gamesServerDir, 'public');
    fs.mkdirSync(publicDir, { recursive: true });
    fs.copyFileSync(path.join(electronDist, setupExe), path.join(publicDir, 'FreeplayDownloader-Setup.exe'));
    console.log(`✓ Copied ${setupExe} -> games/server/public/FreeplayDownloader-Setup.exe`);
  }

  if (fs.existsSync(gamesServerDir)) {
    if (fs.existsSync(gamesAndroidDir)) {
      console.log('[Games] Preparing the cloud web bundle for the Android offline library...');
      if (!runCommand('node', ['scripts/generate-pwa-icons.mjs'], gamesServerDir)) {
        throw new Error('Could not generate FREEPLAY PWA icons.');
      }
      if (!runCommand('npx', ['vite', 'build'], gamesServerDir)) {
        throw new Error('Games web bundle preparation failed; Android app was not built.');
      }

      console.log('[Games] Compiling Android APK with bundled web assets and emulator cores...');
      const androidBuildSucceeded = fs.existsSync(gradleBat)
        ? runCommand(gradleBat, ['assembleDebug'], gamesAndroidDir)
        : runCommand('cmd.exe', ['/c', 'build.bat'], gamesAndroidDir);
      if (!androidBuildSucceeded) {
        throw new Error('Games Android APK build failed.');
      }

      const apkOut = path.join(gamesAndroidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
      if (!fs.existsSync(apkOut)) throw new Error(`Games Android APK was not produced: ${apkOut}`);
      const serverPublicApk = path.join(gamesServerDir, 'public', 'freeplay.apk');
      fs.mkdirSync(path.dirname(serverPublicApk), { recursive: true });
      fs.copyFileSync(apkOut, serverPublicApk);
      fs.copyFileSync(apkOut, path.join(apksDistDir, 'freeplay.apk'));
      console.log('✓ Copied freeplay.apk into games/server/public and dist/apks/');
    }

    console.log('[Games] Compiling Web App (vite build)...');
    if (!runCommand('npx', ['vite', 'build'], gamesServerDir)) {
      throw new Error('Games server web build failed.');
    }

    console.log(`[Games] Exporting to ${gamesDist}...`);
    copyClean(gamesServerDir, gamesDist, ['src', 'tmp']);
    console.log(`✓ Exported FREEPLAY server, backend, and web assets to ${gamesDist}`);
  }
}

// -----------------------------------------------------------------------------
// 5. Downloader Server -> dist/downloader
// -----------------------------------------------------------------------------
if (!only || only === 'downloader') {
  console.log('\n==================================================================');
  console.log(' [5/5] Packaging Central Downloader Server (/downloader)');
  console.log('==================================================================');
  const downloaderSrc = path.join(root, 'downloader');
  if (fs.existsSync(downloaderSrc)) {
    copyClean(downloaderSrc, downloaderDist, ['downloads']);
    console.log(`✓ Exported unified downloader server -> ${downloaderDist}`);
  }
}

// Summary of all files in dist/
console.log('\n╔══════════════════════════════════════════════════════════════════╗');
console.log('║       ✓ All butfree.online Apps Compiled Into /dist!             ║');
console.log('╚══════════════════════════════════════════════════════════════════╝\n');

console.log('Generated Deployment Targets in /dist:');
console.log('──────────────────────────────────────────────────────────────────');
if (fs.existsSync(welcomeDist)) console.log('  🌐 dist/welcome/      - Landing page & Google OAuth legal pages');
if (fs.existsSync(comicsDist))  console.log('  📚 dist/comics/       - ComixoloFree Web App & Cloud Server');
if (fs.existsSync(musicDist))   console.log('  🎵 dist/music/        - Fraudio Web App & Lossless Audio Server');
if (fs.existsSync(tvDist))      console.log('  🎬 dist/tv/           - Freevee Web App & Streaming Server');
if (fs.existsSync(gamesDist))   console.log('  🎮 dist/games/        - FREEPLAY Web App & Retro Arcade Server');
if (fs.existsSync(downloaderDist)) console.log('  ⚡ dist/downloader/   - Central Torrent & Media Downloader');
if (fs.existsSync(apksDistDir)) {
  console.log('  📦 dist/apks/         - Standalone Mobile & TV Packages:');
  const apks = fs.readdirSync(apksDistDir);
  for (const apk of apks) {
    const sizeMb = (fs.statSync(path.join(apksDistDir, apk)).size / (1024 * 1024)).toFixed(2);
    console.log(`     • ${apk.padEnd(20)} (${sizeMb} MB)`);
  }
}
console.log('──────────────────────────────────────────────────────────────────\n');
