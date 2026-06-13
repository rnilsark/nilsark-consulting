import { insertChatMessage, markOutboxSent, selectPendingOutbox, type Db } from './db.ts';
import type { Channel } from './channels/types.ts';

/**
 * Deliver pending outbox rows via the live channel sockets (main process only). On success, log
 * the message as outbound chat and mark it sent; on failure leave it pending to retry next tick.
 * Workers queue these — they can't send themselves because they don't own the connection.
 */
export async function drainOutbox(db: Db, channels: Map<string, Channel>): Promise<void> {
  for (const row of selectPendingOutbox(db)) {
    const channel = channels.get(row.channel);
    if (!channel) {
      console.error(`[outbox] no live channel "${row.channel}" for reply ${row.id} — leaving pending`);
      continue;
    }
    try {
      await channel.send(row.conversation_id, row.text);
      insertChatMessage(db, {
        channel: row.channel,
        conversation_id: row.conversation_id,
        sender: 'harness',
        direction: 'out',
        text: row.text,
      });
      markOutboxSent(db, row.id);
    } catch (err) {
      console.error(`[outbox] send failed (${row.channel} ${row.conversation_id}) — retry next tick:`, err);
    }
  }
}
