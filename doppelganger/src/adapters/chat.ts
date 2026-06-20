import { getChannelCursor, insertChatMessage, insertQueue, setChannelCursor, type Db } from '../db.ts';
import type { Channel } from '../channels/types.ts';

/** Adapter source name — what the triage queue rows are attributed to in the registry. */
export const CHAT_INGEST_SOURCE = 'chat-ingest';

/** Digits of a phone-number identity, ignoring `+` and any `@domain` JID suffix. */
function numberDigits(s: string): string {
  return s.replace(/@.*$/, '').replace(/\D/g, '');
}

/**
 * Allowlist gate for who may reach the harness. Empty list = open (no filter). Entries containing
 * `@` match a JID exactly (against the sender or the conversation); plain entries are phone numbers
 * matched on digits (so `+46…`, `46…`, and `46…@s.whatsapp.net` all compare equal).
 */
export function isAllowed(sender: string, conversationId: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const sNum = numberDigits(sender);
  for (const entry of allowlist) {
    if (entry.includes('@')) {
      if (entry === sender || entry === conversationId) return true;
    } else {
      const eNum = entry.replace(/\D/g, '');
      if (eNum && eNum === sNum) return true;
    }
  }
  return false;
}

/** True if `identity` (a sender id in any form) is the operator's phone number, compared on digits. */
export function isOperator(identity: string, operatorNumber: string): boolean {
  const want = operatorNumber.replace(/\D/g, '');
  return want !== '' && numberDigits(identity) === want;
}

/**
 * Dumb ingest poll (no LLM): for each channel, read new messages, log them inbound, advance the
 * cursor, and enqueue a `triage` job per message. Triage (Haiku) is the gate that decides whether
 * a message is actually directed at the harness; this adapter just gets messages onto the queue.
 */
export function ingestChat(
  db: Db,
  channels: Map<string, Channel>,
  allowlist: string[] = [],
  operatorNumber = '',
): void {
  for (const channel of channels.values()) {
    const cursor = getChannelCursor(db, channel.name);
    const { messages, cursor: nextCursor } = channel.poll(cursor);
    for (const msg of messages) {
      if (!isAllowed(msg.sender, msg.conversationId, allowlist)) {
        console.log(`[chat-ingest] ${channel.name}: blocked ${msg.sender} (conv ${msg.conversationId}) — not in allowlist`);
        continue;
      }
      insertChatMessage(db, {
        channel: msg.channel,
        conversation_id: msg.conversationId,
        sender: msg.sender,
        direction: 'in',
        text: msg.text,
        ts: msg.ts,
        is_direct: msg.isDirect,
      });
      // Everything goes through triage — one uniform path, so the gate is exercised constantly and
      // never rots. We hand triage the room context (1:1 vs group, and whether the sender is the
      // operator) so it can escalate the operator's own DM unconditionally: a 1:1 with the operator
      // is by definition for the harness, so triage must never drop it.
      insertQueue(db, {
        agent: 'triage',
        task: JSON.stringify({
          channel: msg.channel,
          conversationId: msg.conversationId,
          text: msg.text,
          isDirect: msg.isDirect === true,
          fromOperator: isOperator(msg.sender, operatorNumber),
        }),
        parent: null,
      });
    }
    if (nextCursor !== cursor) setChannelCursor(db, channel.name, nextCursor);
    if (messages.length > 0) {
      console.log(`[chat-ingest] ${channel.name}: ${messages.length} new → triage`);
    }
  }
}
