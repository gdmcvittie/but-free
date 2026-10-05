import fs from 'fs';
import path from 'path';

const src = path.resolve('dist');
const dest = path.resolve('../dist/server/dist');

if (fs.existsSync(src) && fs.existsSync(path.resolve('../dist/server'))) {
  fs.cpSync(src, dest, { recursive: true });
  console.log('✓ Synced server/dist to dist/server/dist');
}
