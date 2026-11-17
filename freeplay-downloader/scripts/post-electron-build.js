// Zips the built Windows exe(s) and copies them next to the project folder.
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const electronDist = join(root, 'dist_electron');

if (!existsSync(electronDist)) {
  console.warn('[Build] dist_electron folder not found');
  process.exit(0);
}

const files = readdirSync(electronDist);
const exeFiles = files
  .filter(f => f.toLowerCase().endsWith('.exe'))
  .map(f => {
    const fullPath = join(electronDist, f);
    return { name: f, path: fullPath, mtime: statSync(fullPath).mtimeMs };
  })
  .sort((a, b) => b.mtime - a.mtime);

if (exeFiles.length === 0) {
  console.warn('[Build] No .exe file found in dist_electron');
  process.exit(0);
}

for (const targetExe of exeFiles) {
  console.log(`[Build] Zipping ${targetExe.name} into freeplay-downloader-latest-win64.zip`);
  const zip = new AdmZip();
  zip.addLocalFile(targetExe.path);
  const localZipPath = join(electronDist, 'freeplay-downloader-latest-win64.zip');
  zip.writeZip(localZipPath);
  console.log(`[Build] Created local zip: ${localZipPath}`);

  const parentZipPath = resolve(root, '..', 'freeplay-downloader-latest-win64.zip');
  try {
    zip.writeZip(parentZipPath);
    console.log(`[Build] Copied to parent folder: ${parentZipPath}`);
  } catch (_) {}

  // Also stage the setup executable in games/server/public for web downloads
  const setupExe = exeFiles.find(f => f.name.toLowerCase().includes('setup'));
  if (setupExe) {
    const gamesServerPublic = resolve(root, '..', 'games', 'server', 'public');
    if (existsSync(gamesServerPublic)) {
      try {
        const dest = join(gamesServerPublic, 'FreeplayDownloader-Setup.exe');
        copyFileSync(setupExe.path, dest);
        console.log(`[Build] Staged installer to: ${dest}`);
      } catch (err) {
        console.warn(`[Build] Failed to stage installer to games/server/public:`, err.message);
      }
    }
  }

  break; // Zip only the newest exe (the installer if both targets ran)
}
