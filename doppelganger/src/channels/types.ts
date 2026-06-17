// A channel is a bidirectional text adapter — nothing more is abstracted (text in, text out).
// Reactions / attachments / read-receipts / typing are deliberately out of scope: a rich
// interface leaks, a text interface ports cleanly (WhatsApp now, iMessage later).

export interface InboundMessage {
  channel: string;
  /** Opaque thread id (WhatsApp JID / iMessage chat-GUID). Never assume a format. */
  conversationId: string;
  /** Opaque sender id. */
  sender: string;
  text: string;
  ts: string;
  /**
   * True if this is a direct (1:1) thread with the harness; false/absent for a group. The channel
   * knows its own format and sets this — consumers must NOT sniff the conversationId. Drives the
   * "operator DM bypasses triage" gate and marks rows so we can find the operator's own DM thread.
   */
  isDirect?: boolean;
}

export interface PollResult {
  messages: InboundMessage[];
  /** The new cursor to persist; pass it back on the next poll. Unchanged if nothing new. */
  cursor: string;
}

export interface Channel {
  name: string;
  /** New messages since `cursor` (null = first poll), plus the advanced cursor. */
  poll(cursor: string | null): PollResult;
  /** Deliver an outgoing message into a conversation. Throws/rejects on failure. */
  send(conversationId: string, text: string): void | Promise<void>;
}
