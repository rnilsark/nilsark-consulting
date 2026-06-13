import { getChannelCursor, insertChatMessage, insertQueue, setChannelCursor, type Db } from '../db.ts';
import type { Channel } from '../channels/types.ts';

/** Adapter source name — what the triage queue rows are attributed to in the registry. */
export const CHAT_INGEST_SOURCE = 'chat-ingest';

/**
 * Dumb ingest poll (no LLM): for each channel, read new messages, log them inbound, advance the
 * cursor, and enqueue a `triage` job per message. Triage (Haiku) is the gate that decides whether
 * a message is actually directed at the harness; this adapter just gets messages onto the queue.
 */
export function ingestChat(db: Db, channels: Map<string, Channel>): void {
  for (const channel of channels.values()) {
    const cursor = getChannelCursor(db, channel.name);
    const { messages, cursor: nextCursor } = channel.poll(cursor);
    for (const msg of messages) {
      insertChatMessage(db, {
        channel: msg.channel,
        conversation_id: msg.conversationId,
        sender: msg.sender,
        direction: 'in',
        text: msg.text,
        ts: msg.ts,
      });
      insertQueue(db, {
        agent: 'triage',
        task: JSON.stringify({ channel: msg.channel, conversationId: msg.conversationId, text: msg.text }),
        parent: null,
      });
    }
    if (nextCursor !== cursor) setChannelCursor(db, channel.name, nextCursor);
    if (messages.length > 0) {
      console.log(`[chat-ingest] ${channel.name}: ${messages.length} new → triage`);
    }
  }
}
