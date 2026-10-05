/**
 * Server-Sent Events broadcaster.
 *
 * Long running work (torrent downloads, Drive uploads, library scans) pushes
 * progress here so the UI updates live instead of polling. A small ring buffer
 * keeps the most recent events for clients that connect late.
 */

const BUFFER_SIZE = 50;
const buffer = [];
const clients = new Set();

let nextId = 1;

export function broadcast(type, data = {}) {
  const event = { id: nextId++, type, data, at: Date.now() };
  buffer.push(event);
  if (buffer.length > BUFFER_SIZE) buffer.shift();

  const payload = `id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
  return event;
}

export function recentEvents(sinceId = 0) {
  return buffer.filter((e) => e.id > sinceId);
}

export function attachClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');

  clients.add(res);

  // Replay anything the client missed while reconnecting.
  const lastId = Number(req.headers['last-event-id'] || req.query?.since || 0);
  for (const event of recentEvents(lastId)) {
    res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  }

  // Comment frames keep proxies from closing an idle stream.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(res);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
}

export function clientCount() {
  return clients.size;
}

export default { broadcast, attachClient, recentEvents, clientCount };
