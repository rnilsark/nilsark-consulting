import { mkdirSync } from 'node:fs';
import { now } from '../db.ts';
import type { Channel, InboundMessage, PollResult } from './types.ts';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';

/**
 * WhatsApp channel running IN-PROCESS via Baileys (a Node reimplementation of WhatsApp Web).
 * No separate bridge/daemon. The socket lives in the long-lived main process: inbound messages
 * are buffered as they arrive and drained by poll(); outbound is sent on the same socket.
 *
 * Honest: Baileys is unofficial — WhatsApp can force client upgrades (fix = `npm update baileys`),
 * and an in-process socket has no crash isolation. The Channel interface keeps the option to move
 * this to a child process later.
 */

/** Pull a plain-text InboundMessage out of a Baileys message, or null if it isn't one we handle. */
export function extractInbound(m: WAMessage): InboundMessage | null {
  if (m.key.fromMe) return null;
  const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? null;
  if (!text) return null; // text-only by contract: skip media/reactions/system
  const conversationId = m.key.remoteJid;
  if (!conversationId) return null;
  const ts =
    typeof m.messageTimestamp === 'number'
      ? new Date(m.messageTimestamp * 1000).toISOString()
      : now();
  // Resolve the sender's phone-number JID. WhatsApp increasingly addresses by an opaque `@lid`;
  // the alternate field (remoteJidAlt for DMs, participantAlt in groups) carries the real number
  // (`<number>@s.whatsapp.net`). Prefer it so the allowlist can match on a phone number; fall back
  // to the lid/jid we do have.
  const isGroup = conversationId.endsWith('@g.us');
  const senderJid = isGroup ? (m.key.participant ?? conversationId) : conversationId;
  const senderAlt = isGroup ? m.key.participantAlt : m.key.remoteJidAlt;
  return {
    channel: 'whatsapp',
    conversationId,
    sender: senderAlt ?? senderJid,
    text,
    ts,
  };
}

export function makeWhatsappChannel(authDir: string): Channel {
  const buffer: InboundMessage[] = [];
  let sock: WASocket | null = null;
  let readyResolve: (() => void) | null = null;
  let ready: Promise<void> = new Promise((r) => (readyResolve = r));
  let connecting = false;

  async function connect(): Promise<void> {
    if (connecting || sock) return;
    connecting = true;
    // Lazy: Baileys is a heavy dependency — load it only when WhatsApp actually connects, so
    // stub-only / WhatsApp-off runs don't pay its import cost at startup.
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = await import(
      '@whiskeysockets/baileys'
    );
    const { default: pino } = await import('pino');
    const { default: qrcode } = await import('qrcode-terminal');
    mkdirSync(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }) });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        console.log('[whatsapp] scan this QR from the provisioned number (Linked devices):');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        console.log('[whatsapp] connected');
        readyResolve?.();
      }
      if (connection === 'close') {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        sock = null;
        connecting = false;
        ready = new Promise((r) => (readyResolve = r));
        if (code === DisconnectReason.loggedOut) {
          console.error('[whatsapp] logged out — delete the auth dir and re-pair (QR).');
        } else {
          console.error(`[whatsapp] connection closed (code ${code ?? '?'}) — reconnecting`);
          void connect();
        }
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        const inbound = extractInbound(m);
        if (inbound) buffer.push(inbound);
      }
    });
  }

  // Connect eagerly so the QR prints at startup and inbound starts flowing.
  void connect();

  return {
    name: 'whatsapp',
    poll(): PollResult {
      const messages = buffer.splice(0, buffer.length);
      return { messages, cursor: '' };
    },
    async send(conversationId: string, text: string): Promise<void> {
      await connect();
      await ready;
      if (!sock) throw new Error('whatsapp socket not connected');
      await sock.sendMessage(conversationId, { text });
    },
  };
}
