import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

if (process.env.BUTFREE_INSTALL_RUNNING === '1') {
  process.exit(0);
}

console.log('\n╔══════════════════════════════════════════════════════════════════╗');
console.log('║   butfree.online - Installing Packages For All Sub-Apps          ║');
console.log('╚══════════════════════════════════════════════════════════════════╝\n');

const APPS = [
  { name: 'Comics (comixolofree)', dir: path.join(root, 'comics', 'server') },
  { name: 'Music (fraudio)', dir: path.join(root, 'music', 'server') },
  { name: 'TV Server (freevee)', dir: path.join(root, 'tv', 'server') },
  { name: 'TV FireTV (freevee)', dir: path.join(root, 'tv', 'firetv') },
  { name: 'Central Downloader', dir: path.join(root, 'downloader') },
  { name: 'Freeplay Downloader (PC)', dir: path.join(root, 'freeplay-downloader') }
];

const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

for (const app of APPS) {
  const pkgJson = path.join(app.dir, 'package.json');
  if (!fs.existsSync(pkgJson)) {
    console.log(`[SKIP] No package.json found in ${app.name}`);
    continue;
  }

  console.log(`📦 Installing dependencies for ${app.name}...`);
  console.log(`   Directory: ${app.dir}`);

  const res = spawnSync(npmCmd, ['install', '--no-workspaces'], {
    cwd: app.dir,
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      BUTFREE_INSTALL_RUNNING: '1'
    }
  });

  if (res.status === 0) {
    console.log(`✓ [${app.name}] Installed successfully.\n`);
  } else {
    // If --no-workspaces fails or is unsupported on an older npm version, fallback to standard install
    const fallbackRes = spawnSync(npmCmd, ['install'], {
      cwd: app.dir,
      stdio: 'inherit',
      shell: true,
      env: {
        ...process.env,
        BUTFREE_INSTALL_RUNNING: '1'
      }
    });
    if (fallbackRes.status === 0) {
      console.log(`✓ [${app.name}] Installed successfully via fallback.\n`);
    } else {
      console.warn(`[WARN] [${app.name}] npm install exited with code ${fallbackRes.status}.\n`);
    }
  }
}

console.log('══════════════════════════════════════════════════════════════════');
console.log('✓ All sub-app dependencies installed across the entire monorepo!');
console.log('══════════════════════════════════════════════════════════════════\n');
