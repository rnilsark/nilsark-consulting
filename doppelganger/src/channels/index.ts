import { config } from '../config.ts';
import { makeImessageChannel } from './imessage.ts';
import { makeStubChannel } from './stub.ts';
import { makeWhatsappChannel } from './whatsapp.ts';
import type { Channel } from './types.ts';

/** Build the channels named in config (DOPPELGANGER_CHANNELS), keyed by name. */
export function loadChannels(): Map<string, Channel> {
  const channels = new Map<string, Channel>();
  for (const name of config.channels) {
    const channel = makeChannel(name);
    if (channel) channels.set(channel.name, channel);
    else console.error(`[channels] unknown channel "${name}", skipping`);
  }
  return channels;
}

function makeChannel(name: string): Channel | undefined {
  switch (name) {
    case 'stub':
      return makeStubChannel(config.stubInbox, config.stubOutbox);
    case 'whatsapp':
      return makeWhatsappChannel(config.whatsappAuthDir);
    case 'imessage':
      return makeImessageChannel({
        serverUrl: config.imessageServerUrl,
        password: config.imessagePassword,
        pollMs: config.imessagePollMs,
      });
    default:
      return undefined;
  }
}
