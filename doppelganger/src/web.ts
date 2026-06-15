// Dashboard web server: serves the static constellation UI and projects the
// events table into /api/state. No dependencies, no SSE — the client polls.

import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { openDb, type Db } from './db.ts';
import { project, windowSince, type WindowKey } from './projection.ts';
import { loadRegistry } from './registry.ts';
import { loadAgentConfigs } from './settings.ts';
import type { EventRow, Registry } from './types.ts';

const webDir = path.join(import.meta.dirname, '..', 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function parseWindow(value: string | null): WindowKey {
  return value === 'hour' || value === 'today' ? value : 'live';
}

export function startWeb(
  db: Db,
  registry: Registry,
  port: number = config.webPort,
  host: string = config.webHost,
): http.Server {
  const eventsSince = db.prepare(
    `SELECT * FROM events WHERE ts >= ? ORDER BY id DESC LIMIT 500`,
  );

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/api/state') {
      const win = parseWindow(url.searchParams.get('window'));
      const windowEvents = eventsSince.all(windowSince(win)) as EventRow[];
      const todayEvents =
        win === 'today' ? windowEvents : (eventsSince.all(windowSince('today')) as EventRow[]);
      const state = project(windowEvents, todayEvents, Object.keys(registry.agents));
      const configs = loadAgentConfigs(registry);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ...state, configs }));
      return;
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(webDir, path.normalize(rel));
    if (!file.startsWith(webDir + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
  });

  server.listen(port, host, () => {
    console.log(`[web] dashboard on http://${host}:${port}`);
  });
  return server;
}

// Standalone entry (`npm run web`): serve the dashboard without the dispatcher.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDb(config.dbPath);
  const registry = loadRegistry();
  startWeb(db, registry);
}
