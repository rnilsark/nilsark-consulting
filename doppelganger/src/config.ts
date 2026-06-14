import cron from 'node-cron';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Config has three layers, by precedence (low → high):
//   1. defaults (below)
//   2. the host config file:  $DOPPELGANGER_HOME/config.json   (the primary, durable surface)
//   3. environment variables  (deploy-time overrides; see envVar map)
// Everything is validated and we THROW on anything unknown or malformed — a misconfigured daemon
// should fail loudly at startup, never silently fall back to a default.
//
// DOPPELGANGER_HOME is the one exception: it's env-only, because it *locates* the config file.

const KNOWN_CHANNELS = ['stub', 'whatsapp', 'imessage'] as const;

interface OperatorConfig {
  channels: string[];
  dispatchIntervalMs: number;
  maxAttempts: number;
  webPort: number;
  morningBriefCron: string;
  financeHeartbeatCron: string;
  chatPollCron: string;
  chatMemoryLines: number;
  allowedSenders: string[];
  claudeBin: string;
  operatorConversationId: string;
  imessageServerUrl: string;
  imessagePassword: string;
  imessagePollMs: number;
  selfUpdateEnabled: boolean;
  selfUpdateCron: string;
  selfUpdateRef: string;
}

const defaults: OperatorConfig = {
  channels: ['stub'],
  dispatchIntervalMs: 5000,
  maxAttempts: 3,
  webPort: 4317,
  morningBriefCron: '0 7 * * *',
  financeHeartbeatCron: '0 8 * * 1',
  chatPollCron: '*/10 * * * * *',
  chatMemoryLines: 12,
  allowedSenders: [],
  claudeBin: 'claude',
  operatorConversationId: '',
  imessageServerUrl: '',
  imessagePassword: '',
  imessagePollMs: 5000,
  selfUpdateEnabled: false, // OFF by default — never self-update a dev checkout; prod box opts in.
  selfUpdateCron: '*/5 * * * *',
  selfUpdateRef: 'stable',
};

/** The env var that overrides each operator key (keys not listed are file/default only). */
const envVar: Record<keyof OperatorConfig, string> = {
  channels: 'DOPPELGANGER_CHANNELS',
  dispatchIntervalMs: 'DOPPELGANGER_DISPATCH_INTERVAL_MS',
  maxAttempts: 'DOPPELGANGER_MAX_ATTEMPTS',
  webPort: 'DOPPELGANGER_WEB_PORT',
  morningBriefCron: 'DOPPELGANGER_MORNING_BRIEF_CRON',
  financeHeartbeatCron: 'DOPPELGANGER_FINANCE_HEARTBEAT_CRON',
  chatPollCron: 'DOPPELGANGER_CHAT_POLL_CRON',
  chatMemoryLines: 'DOPPELGANGER_CHAT_MEMORY_LINES',
  allowedSenders: 'DOPPELGANGER_ALLOWED_SENDERS',
  claudeBin: 'DOPPELGANGER_CLAUDE_BIN',
  operatorConversationId: 'DOPPELGANGER_OPERATOR_CONVERSATION_ID',
  imessageServerUrl: 'DOPPELGANGER_IMESSAGE_SERVER_URL',
  imessagePassword: 'DOPPELGANGER_IMESSAGE_PASSWORD',
  imessagePollMs: 'DOPPELGANGER_IMESSAGE_POLL_MS',
  selfUpdateEnabled: 'DOPPELGANGER_SELF_UPDATE_ENABLED',
  selfUpdateCron: 'DOPPELGANGER_SELF_UPDATE_CRON',
  selfUpdateRef: 'DOPPELGANGER_SELF_UPDATE_REF',
};

function fail(msg: string): never {
  throw new Error(`[config] ${msg}`);
}

/** Read + shallow-validate the host config file. Missing → {}. Unknown keys / bad JSON → throw. */
function loadFile(home: string): Partial<Record<keyof OperatorConfig, unknown>> {
  const file = path.join(home, 'config.json');
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return fail(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail(`${file} must be a JSON object`);
  }
  for (const key of Object.keys(parsed)) {
    if (!(key in defaults)) {
      return fail(`${file}: unknown key "${key}" (allowed: ${Object.keys(defaults).join(', ')})`);
    }
  }
  return parsed as Partial<Record<keyof OperatorConfig, unknown>>;
}

function posInt(raw: unknown, key: string): number {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    return fail(`${key} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function boolVal(raw: unknown, key: string): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fail(`${key} must be a boolean (true/false), got ${JSON.stringify(raw)}`);
}

function nonEmptyStr(raw: unknown, key: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') return fail(`${key} must be a non-empty string`);
  return raw;
}

/** A string that may be empty — empty means "feature off" (e.g. no operator push target). */
function optStr(raw: unknown, key: string): string {
  if (typeof raw !== 'string') return fail(`${key} must be a string`);
  return raw;
}

function cronExpr(raw: unknown, key: string): string {
  const s = nonEmptyStr(raw, key);
  if (!cron.validate(s)) return fail(`${key} is not a valid cron expression: "${s}"`);
  return s;
}

/** A list of free-form strings: a JSON array, or a comma-separated string via env. Empty allowed. */
function strList(raw: unknown, key: string): string[] {
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : fail(`${key} must be an array of strings (or a comma-separated string via env)`);
  for (const v of arr) if (typeof v !== 'string') return fail(`${key} entries must be strings`);
  return arr as string[];
}

function channelList(raw: unknown, key: string): string[] {
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : fail(`${key} must be an array of channel names (or a comma-separated string via env)`);
  for (const c of arr) {
    if (typeof c !== 'string' || !KNOWN_CHANNELS.includes(c as (typeof KNOWN_CHANNELS)[number])) {
      return fail(`${key}: unknown channel ${JSON.stringify(c)} (known: ${KNOWN_CHANNELS.join(', ')})`);
    }
  }
  return arr;
}

function resolve(home: string): OperatorConfig {
  const file = loadFile(home);
  const raw = <K extends keyof OperatorConfig>(key: K): unknown =>
    process.env[envVar[key]] ?? (key in file ? file[key] : defaults[key]);
  return {
    channels: channelList(raw('channels'), 'channels'),
    dispatchIntervalMs: posInt(raw('dispatchIntervalMs'), 'dispatchIntervalMs'),
    maxAttempts: posInt(raw('maxAttempts'), 'maxAttempts'),
    webPort: posInt(raw('webPort'), 'webPort'),
    morningBriefCron: cronExpr(raw('morningBriefCron'), 'morningBriefCron'),
    financeHeartbeatCron: cronExpr(raw('financeHeartbeatCron'), 'financeHeartbeatCron'),
    chatPollCron: cronExpr(raw('chatPollCron'), 'chatPollCron'),
    chatMemoryLines: posInt(raw('chatMemoryLines'), 'chatMemoryLines'),
    allowedSenders: strList(raw('allowedSenders'), 'allowedSenders'),
    claudeBin: nonEmptyStr(raw('claudeBin'), 'claudeBin'),
    operatorConversationId: optStr(raw('operatorConversationId'), 'operatorConversationId'),
    imessageServerUrl: optStr(raw('imessageServerUrl'), 'imessageServerUrl'),
    imessagePassword: optStr(raw('imessagePassword'), 'imessagePassword'),
    imessagePollMs: posInt(raw('imessagePollMs'), 'imessagePollMs'),
    selfUpdateEnabled: boolVal(raw('selfUpdateEnabled'), 'selfUpdateEnabled'),
    selfUpdateCron: cronExpr(raw('selfUpdateCron'), 'selfUpdateCron'),
    selfUpdateRef: nonEmptyStr(raw('selfUpdateRef'), 'selfUpdateRef'),
  };
}

const home =
  process.env.DOPPELGANGER_HOME ?? path.join(homedir(), '.local', 'share', 'doppelganger');

export const config = {
  /** Runtime state outside the repo: DB, out.json, briefs, tokens. (bootstrap; env-only) */
  home,
  dbPath: path.join(home, 'doppelganger.db'),
  runsDir: path.join(home, 'runs'),
  briefsDir: path.join(home, 'briefs'),

  /** Private, non-repo agent config + context (settings.json, context.md). */
  agentSettingsDir: path.join(home, 'agents'),
  /** Shared context injected into every agent (opt-in; missing → skipped). */
  soulPath: path.join(home, 'soul.md'),

  /** WhatsApp (Baileys) multi-file auth state — QR once, then persisted. Derived from home. */
  whatsappAuthDir: path.join(home, 'whatsapp-auth'),
  /** Stub channel files (pipeline testing without WhatsApp). Derived from home. */
  stubInbox: path.join(home, 'stub-inbox.json'),
  stubOutbox: path.join(home, 'stub-outbox.jsonl'),

  // Operator config: defaults < config.json < env. Validated above.
  ...resolve(home),
};

export function ensureDirs(): void {
  mkdirSync(config.runsDir, { recursive: true });
  mkdirSync(config.briefsDir, { recursive: true });
}

/**
 * First-run convenience: copy config.example.json → $DOPPELGANGER_HOME/config.json if absent, so
 * there's a file to edit. Returns the path if written. (Absent file already means "all defaults",
 * so this changes nothing at runtime — it just gives the operator a starting point.)
 */
export function scaffoldConfig(): string | null {
  const dest = path.join(home, 'config.json');
  if (existsSync(dest)) return null;
  const example = path.join(import.meta.dirname, '..', 'config.example.json');
  if (!existsSync(example)) return null;
  mkdirSync(home, { recursive: true });
  copyFileSync(example, dest);
  return dest;
}
