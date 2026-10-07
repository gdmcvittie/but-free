import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');
const svgPath = path.join(publicDir, 'freeplay-pwa-icon.svg');

if (!fs.existsSync(svgPath)) {
  throw new Error(`FREEPLAY PWA icon source is missing: ${svgPath}`);
}

const svg = fs.readFileSync(svgPath);
for (const size of [192, 512]) {
  await sharp(svg)
    .resize(size, size)
    .png()
    .toFile(path.join(publicDir, `icon-${size}.png`));
}

console.log('[PWA] Generated 192px and 512px FREEPLAY install icons.');
