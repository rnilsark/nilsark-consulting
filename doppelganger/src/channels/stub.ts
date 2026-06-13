import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { now } from '../db.ts';
import type { Channel, InboundMessage, PollResult } from './types.ts';

/**
 * A file-backed channel for proving the pipeline end-to-end without the real WhatsApp daemon.
 * `inbox` is a JSON array of { conversationId, sender, text, ts? }; the cursor is the count of
 * messages already consumed. `send()` appends one JSON line per reply to `outbox`.
 */
export function makeStubChannel(inboxPath: string, outboxPath: string): Channel {
  return {
    name: 'stub',
    poll(cursor: string | null): PollResult {
      const seen = cursor ? Number(cursor) : 0;
      if (!existsSync(inboxPath)) return { messages: [], cursor: String(seen) };
      const all = JSON.parse(readFileSync(inboxPath, 'utf8')) as Array<{
        conversationId: string;
        sender: string;
        text: string;
        ts?: string;
      }>;
      const fresh = all.slice(seen);
      const messages: InboundMessage[] = fresh.map((m) => ({
        channel: 'stub',
        conversationId: m.conversationId,
        sender: m.sender,
        text: m.text,
        ts: m.ts ?? now(),
      }));
      return { messages, cursor: String(all.length) };
    },
    send(conversationId: string, text: string): void {
      mkdirSync(path.dirname(outboxPath), { recursive: true });
      appendFileSync(outboxPath, JSON.stringify({ conversationId, text, ts: now() }) + '\n');
    },
  };
}
