import { loadChannels } from './channels/index.ts';
import { config, ensureDirs, scaffoldConfig } from './config.ts';
import { startDispatcher } from './dispatcher.ts';
import { openDb } from './db.ts';
import { loadRegistry } from './registry.ts';
import { startScheduler } from './scheduler.ts';
import { startSelfUpdate } from './selfupdate.ts';
import { scaffoldAgentSettings } from './settings.ts';
import { startWeb } from './web.ts';

ensureDirs();
const db = openDb(config.dbPath);
const registry = loadRegistry();

console.log(`[doppelganger] home=${config.home}`);
console.log(`[doppelganger] agents: ${Object.keys(registry.agents).join(', ')}`);
console.log(`[doppelganger] channels: ${config.channels.join(', ')}`);

const configPath = scaffoldConfig();
if (configPath) console.log(`[doppelganger] wrote starter config: ${configPath} (edit to set channels, ports, intervals)`);

const scaffolded = scaffoldAgentSettings(Object.keys(registry.agents));
if (scaffolded.length > 0) {
  console.log(
    `[doppelganger] wrote starter settings for: ${scaffolded.join(', ')} — edit ${config.agentSettingsDir}/<agent>/settings.json before first run`,
  );
}

// Channels are loaded ONCE here and shared: the live socket (e.g. WhatsApp/Baileys) lives in this
// long-lived process for both inbound (ingest) and outbound (outbox drain). Workers never connect.
const channels = loadChannels();
startScheduler(db, channels);
startSelfUpdate();
const dispatcher = startDispatcher(db, registry);
const web = startWeb(db, registry);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[doppelganger] ${signal} — shutting down (running workers finish on their own)`);
    clearInterval(dispatcher);
    web.close();
    db.close();
    process.exit(0);
  });
}
