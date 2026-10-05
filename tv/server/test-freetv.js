import { spawn } from 'child_process';

const server = spawn('node', ['server.js'], { cwd: 'c:/_code/___MY-TV/my-tv/cloud' });

let output = '';
server.stdout.on('data', d => { output += d.toString(); });
server.stderr.on('data', d => { output += d.toString(); });

setTimeout(async () => {
  try {
    const res = await fetch('http://localhost:42069/api/services');
    const data = await res.json();
    console.log('Services status:', res.status, 'Total services:', data.services?.length);
    const liveServices = data.services?.filter(s => s.isLive) || [];
    console.log('Live services:', liveServices.map(s => s.name));

    const plutoRes = await fetch('http://localhost:42069/api/services/pluto');
    const plutoData = await plutoRes.json();
    console.log('Pluto status:', plutoRes.status, 'Channels:', plutoData.channels?.length, 'Categories:', plutoData.categories?.length);

    const rokuRes = await fetch('http://localhost:42069/api/services/roku');
    const rokuData = await rokuRes.json();
    console.log('Roku status:', rokuRes.status, 'Channels:', rokuData.channels?.length);
  } catch (err) {
    console.error('Test error:', err.message);
  } finally {
    server.kill();
    process.exit(0);
  }
}, 3000);
