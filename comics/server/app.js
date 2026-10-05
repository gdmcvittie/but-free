/**
 * COMIXOLOFREE  — Namecheap cPanel / Passenger entry point.
 *
 * Logging is fully self-contained here (no separate module to fail loading), so a
 * startup problem is always written to server.log next to this file.
 */
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '16';
}
const fs = require('fs');
const path = require('path');

// Explicitly load root .env from monorepo root, with local fallback
const rootEnv = path.resolve(__dirname, '../../.env');
if (fs.existsSync(rootEnv)) {
  require('dotenv').config({ path: rootEnv });
}
require('dotenv').config();

// ---------------------------------------------------------------------------
// Self-contained file logger (must not throw, ever)
// ---------------------------------------------------------------------------
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, 'server.log');
let logStream = null;
try {
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  logStream.on('error', () => { logStream = null; });
} catch (e) {
  logStream = null;
}

function stringify(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  if (a === undefined) return 'undefined';
  try { return JSON.stringify(a); } catch (e) { return String(a); }
}

function writeLine(level, args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(stringify).join(' ')}\n`;
  try { if (logStream) logStream.write(line); } catch (e) {}
  try { process.stdout.write(line); } catch (e) {}
}

if (!console.__comixPatched) {
  console.log = (...a) => writeLine('INFO', a);
  console.info = (...a) => writeLine('INFO', a);
  console.warn = (...a) => writeLine('WARN', a);
  console.error = (...a) => writeLine('ERROR', a);
  console.__comixPatched = true;
}

// Shared logger for other modules (index.js reads global.__comixLog).
global.__comixLog = writeLine;

process.on('uncaughtException', (err) => {
  writeLine('FATAL', ['Uncaught Exception:', err]);
});
process.on('unhandledRejection', (reason) => {
  writeLine('FATAL', ['Unhandled Rejection:', reason]);
});
process.on('warning', (w) => {
  writeLine('WARN', ['Node warning:', w && w.message ? w.message : w]);
});
process.on('exit', (code) => {
  writeLine('INFO', [`Process exiting with code ${code}`]);
});

console.log('==================== COMIXOLOFREE  server starting ====================');
console.log(`time=${new Date().toISOString()} pid=${process.pid} node=${process.version} platform=${process.platform} arch=${process.arch}`);
console.log(`cwd=${process.cwd()}`);
console.log(`appDir=${__dirname}`);
console.log(`logFile=${LOG_FILE}`);

// ---------------------------------------------------------------------------
// Load the application
// ---------------------------------------------------------------------------
let app;
try {
  app = require('./server/index');
} catch (err) {
  console.error('[COMIXOLOFREE ] FATAL: failed to initialize the app:', err);
  process.exit(1);
}

// Passenger provides 'passenger', a numeric port, or a UNIX domain socket path in process.env.PORT.
// It MUST take priority over PORT_COMICS so Passenger can bind to its worker socket.
const RAW_PORT = process.env.PORT || process.env.PORT_COMICS || 3000;
const isUnixSocket = typeof RAW_PORT === 'string' && !/^\d+$/.test(RAW_PORT);

const server = isUnixSocket
  ? app.listen(RAW_PORT, () => {
      console.log(`[COMIXOLOFREE ] Server listening on Passenger socket: ${RAW_PORT}`);
    })
  : app.listen(parseInt(RAW_PORT, 10) || 3000, () => {
      console.log(`[COMIXOLOFREE ] Server listening on port: ${RAW_PORT}`);
    });

server.on('error', (err) => {
  console.error('[COMIXOLOFREE ] Server listen error:', err);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

module.exports = server;
