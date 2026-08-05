'use strict';

/**
 * Dead-simple static server for site/, so the page can be checked locally.
 *
 * Needed because app.js fetches data.json, and browsers block fetch() over
 * file:// — opening site/index.html directly shows an empty page and looks like a
 * bug in the build. Localhost sidesteps that.
 *
 *   npm run serve   ->  http://localhost:8787
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'site');
const PORT = Number(process.env.PORT) || 8787;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/rss+xml; charset=utf-8',
};

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error('site/ er tom — kør `npm run offline` først.');
  process.exit(1);
}

http
  .createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);

    // Never serve outside site/, however creative the URL.
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Findes ikke: ' + rel);
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      }).end(buf);
    });
  })
  .listen(PORT, () => {
    console.log(`Linsejagt kører på http://localhost:${PORT}  (Ctrl+C for at stoppe)`);
  });
