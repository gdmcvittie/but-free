import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('--- Starting Torrent Streamer VPS Architecture Test ---');

const vpsEnv = { ...process.env, PORT: '42079' };
const vpsProcess = spawn('node', ['torrent-node.js'], {
  cwd: path.join(__dirname, 'torrent-streamer'),
  env: vpsEnv
});

vpsProcess.stdout.on('data', d => console.log('[VPS Streamer]:', d.toString().trim()));
vpsProcess.stderr.on('data', d => console.error('[VPS Streamer ERR]:', d.toString().trim()));

const serverEnv = { ...process.env, PORT: '42068', TORRENT_STREAM_SERVER: 'http://127.0.0.1:42079' };
const serverProcess = spawn('node', ['server.js'], {
  cwd: __dirname,
  env: serverEnv
});

serverProcess.stdout.on('data', d => console.log('[Main Server]:', d.toString().trim()));
serverProcess.stderr.on('data', d => console.error('[Main Server ERR]:', d.toString().trim()));

setTimeout(async () => {
  try {
    console.log('\n--- 1. Testing Main Server Torrent Status Endpoint ---');
    const statusRes = await fetch('http://127.0.0.1:42068/api/torrent/status');
    const statusData = await statusRes.json();
    console.log('Torrent Status Result:', JSON.stringify(statusData, null, 2));

    if (statusData.status === 'online' && statusData.mode === 'remote-vps') {
      console.log('✅ Connection test PASSED: Main server connected to VPS Torrent Streamer!');
    } else {
      console.error('❌ Connection test FAILED:', statusData);
    }

    console.log('\n--- 2. Testing VPS Streamer Direct Health Endpoint ---');
    const vpsHealthRes = await fetch('http://127.0.0.1:42079/api/torrent/status');
    const vpsHealthData = await vpsHealthRes.json();
    console.log('VPS Health Result:', JSON.stringify(vpsHealthData, null, 2));

    if (vpsHealthData.status === 'online') {
      console.log('✅ VPS Health test PASSED!');
    }

  } catch (err) {
    console.error('Test Exception:', err);
  } finally {
    console.log('\n--- Cleaning up test processes ---');
    vpsProcess.kill();
    serverProcess.kill();
    process.exit(0);
  }
}, 4000);
