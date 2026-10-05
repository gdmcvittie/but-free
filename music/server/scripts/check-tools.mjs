import { toolStatus } from '../server/binManager.js';

const status = await toolStatus();
for (const [name, info] of Object.entries(status)) {
  const mark = info.available ? 'OK  ' : 'MISS';
  console.log(`${mark} ${name}: ${info.version || info.path || info.setup || 'not installed'}`);
}
process.exit(Object.values(status).every((i) => i.available) ? 0 : 1);