import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const icon512 = path.join(root, 'tv', 'server', 'public', 'icon-512.png');
const icon192 = path.join(root, 'tv', 'server', 'public', 'icon-192.png');
const drawableDir = path.join(root, 'tv', 'android', 'app', 'src', 'main', 'res', 'drawable');

fs.mkdirSync(drawableDir, { recursive: true });

if (fs.existsSync(icon512)) {
  fs.copyFileSync(icon512, path.join(drawableDir, 'ic_launcher.png'));
  fs.copyFileSync(icon512, path.join(drawableDir, 'icon_512.png'));
  console.log('✓ Copied 512px launcher icon to tv/android drawable');
}

if (fs.existsSync(icon192)) {
  fs.copyFileSync(icon192, path.join(drawableDir, 'icon_192.png'));
  console.log('✓ Copied 192px icon to tv/android drawable');
}
