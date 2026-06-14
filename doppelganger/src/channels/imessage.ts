import { randomUUID } from 'node:crypto';
import { now } from '../db.ts';
import type { Channel, InboundMessage, PollResult } from './types.ts';

/**
 * iMessage channel via a BlueBubbles server (https://bluebubbles.app) — a self-hosted REST bridge
 * that drives Messages.app on a logged-in Mac. Doppelgänger runs on that same Mac, so we talk to
 * BlueBubbles over localhost: poll `/message/query` for new inbound, POST `/message/text` to reply.
 *
 * Honest: there is no official iMessage API. BlueBubbles automates a real Mac, and Apple can break
 * it on an OS/Messages update (fix = update BlueBubbles, re-grant Automation/Full-Disk-Access). It
 * needs a Mac signed into iMessage that stays awake. Treat WhatsApp as the resilient fallback.
 *
 * Mirrors the WhatsApp channel's shape: a background poller buffers inbound; poll() drains the
 * buffer synchronously (cursor unused — the watermark is kept in-process). On startup the watermark
 * is "now", so we only ingest messages that arrive after the channel comes up — never replay history.
 */

/** The subset of a BlueBubbles message object we rely on. Everything else is ignored. */
export interface BBMessage {
  guid?: string;
  text?: string | null;
  /** Unix epoch milliseconds. */
  dateCreated?: number;
  isFromMe?: boolean;
  /** Tapbacks/reactions carry an association type (e.g. "like"); plain texts don't. */
  associatedMessageType?: string | null;
  handle?: { address?: string } | null;
  chats?: Array<{ guid?: string }> | null;
}

/** Pull a plain-text InboundMessage out of a BlueBubbles message, or null if it isn't one we handle. */
export function extractInbound(m: BBMessage): InboundMessage | null {
  if (m.isFromMe) return null;
  if (m.associatedMessageType) return null; // text-only by contract: skip tapbacks/reactions
  const text = m.text?.trim();
  if (!text) return null; // skip attachment-only / empty / system messages
  const conversationId = m.chats?.[0]?.guid;
  if (!conversationId) return null;
  const ts = typeof m.dateCreated === 'number' ? new Date(m.dateCreated).toISOString() : now();
  // handle.address is the individual sender (a phone number or iCloud email); in a group the chat
  // guid is the room and the handle is who spoke. Fall back to the chat guid for a 1:1 with no handle.
  const sender = m.handle?.address ?? conversationId;
  return { channel: 'imessage', conversationId, sender, text, ts };
}

export interface ImessageOptions {
  serverUrl: string;
  password: string;
  pollMs: number;
}

export function makeImessageChannel(opts: ImessageOptions): Channel {
  const { serverUrl, password, pollMs } = opts;
  if (!serverUrl) {
    throw new Error('[imessage] serverUrl required (set imessageServerUrl / DOPPELGANGER_IMESSAGE_SERVER_URL)');
  }
  if (!password) {
    throw new Error('[imessage] password required (set imessagePassword / DOPPELGANGER_IMESSAGE_PASSWORD)');
  }

  const base = serverUrl.replace(/\/+$/, '');
  const auth = `password=${encodeURIComponent(password)}`;
  const buffer: InboundMessage[] = [];
  // Watermark: only messages strictly newer than this are ingested. Starts at "now" so history is
  // never replayed. BlueBubbles `after` filters dateCreated > after; the seen-set below dedups the
  // boundary regardless of inclusive/exclusive semantics so a same-millisecond message can't double.
  let sinceMs = Date.now();
  const seen = new Set<string>();
  let polling = false;

  async function tick(): Promise<void> {
    if (polling) return; // never overlap a slow request with the next interval
    polling = true;
    try {
      const res = await fetch(`${base}/api/v1/message/query?${auth}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ with: ['chats', 'handle'], sort: 'ASC', after: sinceMs, limit: 1000 }),
      });
      if (!res.ok) {
        console.error(`[imessage] query failed: ${res.status} ${res.statusText}`);
        return;
      }
      const body = (await res.json()) as { data?: BBMessage[] };
      for (const m of body.data ?? []) {
        if (typeof m.dateCreated === 'number' && m.dateCreated > sinceMs) sinceMs = m.dateCreated;
        if (!m.guid || seen.has(m.guid)) continue;
        seen.add(m.guid);
        const inbound = extractInbound(m);
        if (inbound) buffer.push(inbound);
      }
      // Bound the dedup set, evicting oldest-inserted guids first (Set preserves insertion order),
      // so the most-recent guids — the ones near the watermark — are always retained.
      if (seen.size > 5000) {
        let drop = seen.size - 4000;
        for (const g of seen) {
          if (drop-- <= 0) break;
          seen.delete(g);
        }
      }
    } catch (err) {
      console.error(`[imessage] poll error: ${(err as Error).message}`);
    } finally {
      polling = false;
    }
  }

  const timer = setInterval(() => void tick(), pollMs);
  timer.unref?.(); // don't keep the process alive just for polling
  void tick(); // prime immediately so inbound starts flowing without waiting one interval

  return {
    name: 'imessage',
    poll(): PollResult {
      const messages = buffer.splice(0, buffer.length);
      return { messages, cursor: '' };
    },
    async send(conversationId: string, text: string): Promise<void> {
      const res = await fetch(`${base}/api/v1/message/text?${auth}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chatGuid: conversationId,
          tempGuid: randomUUID(),
          message: text,
          method: 'apple-script',
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`[imessage] send failed: ${res.status} ${res.statusText} ${detail}`.trim());
      }
    },
  };
}
