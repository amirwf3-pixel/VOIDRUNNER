/**
 * Zero-dependency static file server for VOIDRUNNER.
 *
 * ES modules require an http(s) origin, so `file://` will not work. This server
 * exists purely so `npm start` gives a working URL without pulling in a
 * dependency. It refuses to serve outside the project root.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  } catch (error) {
    send(res, 400, 'Bad request');
    console.warn('[server] malformed request URL:', error.message);
    return;
  }

  if (pathname === '/') pathname = '/index.html';

  const resolved = path.resolve(ROOT, `.${pathname}`);
  if (!resolved.startsWith(ROOT)) {
    send(res, 403, 'Forbidden');
    return;
  }

  fs.stat(resolved, (err, stats) => {
    if (err || !stats.isFile()) {
      send(res, 404, `Not found: ${pathname}`, { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const type = MIME[ext] ?? 'application/octet-stream';
    fs.readFile(resolved, (readErr, data) => {
      if (readErr) {
        send(res, 500, 'Internal server error');
        console.error('[server] read failed:', readErr);
        return;
      }
      send(res, 200, data, { 'Content-Type': type });
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  VOIDRUNNER is running');
  console.log(`  →  http://${HOST}:${PORT}/`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[server] port ${PORT} is already in use. Set PORT to another value, e.g. PORT=4200 npm start`);
  } else {
    console.error('[server] failed to start:', error);
  }
  process.exitCode = 1;
});
