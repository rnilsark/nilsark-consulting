import { config, ensureDirs } from './config.ts';
import { startDispatcher } from './dispatcher.ts';
import { openDb } from './db.ts';
import { loadRegistry } from './registry.ts';
import { startScheduler } from './scheduler.ts';

ensureDirs();
const db = openDb(config.dbPath);
const registry = loadRegistry();

console.log(`[doppelganger] home=${config.home}`);
console.log(`[doppelganger] agents: ${Object.keys(registry.agents).join(', ')}`);

startScheduler(db);
const dispatcher = startDispatcher(db, registry);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[doppelganger] ${signal} — shutting down (running workers finish on their own)`);
    clearInterval(dispatcher);
    db.close();
    process.exit(0);
  });
}
