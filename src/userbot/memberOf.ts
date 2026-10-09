/**
 * Per-user membership check via MTProto (channels.getParticipant). The Bot
 * API remains the PRIMARY gate source (live, cheap); this is the second
 * opinion consulted only when the Bot API call errors for a chat - turning
 * the old blind fail-open into a dual-source verification. Loaded lazily:
 * importing this module pulls GramJS, so the gate calls it via dynamic import
 * and tests inject their own checker instead (channelGate.service, `fallback`).
 */
import { getUserbot } from './client.js';

export type MemberOfResult = 'ok' | 'missing';

/** Throws when the userbot itself cannot answer (session missing, flood wait). */
export async function memberOfViaUserbot(chatId: string, userId: number): Promise<MemberOfResult> {
  const client = await getUserbot();
  const { Api } = await import('telegram/tl/index.js');
  const channel = await client.getInputEntity(chatId);
  const participant = await client
    .invoke(new Api.channels.GetParticipant({ channel: channel as never, participant: BigInt(userId) as never }))
    .catch((err: Error) => {
      // USER_NOT_PARTICIPANT / PEER_ID_INVALID means "definitely not inside".
      if (/USER_NOT_PARTICIPANT|PEER_ID_INVALID/i.test(err.message)) return null;
      throw err;
    });
  if (!participant) return 'missing';
  return 'ok';
}
