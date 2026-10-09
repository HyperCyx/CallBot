/**
 * Participant enumeration via the userbot (the only Telegram surface that can
 * list channel/group members). Kept separate from client.ts so the sweep's
 * business logic (membershipAudit.service) can be tested with a stubbed
 * fetcher - GramJS never loads in tests.
 */
import { getUserbot } from './client.js';
import { logger } from '../lib/logger.js';

const PAGE_CAP = 100_000; // sanity ceiling: never loop forever

/**
 * All telegram ids currently inside the chat. The operating account must be a
 * member of the chat (admin of channels to view the member list; any member
 * of a group can list it). Throws on failure - the caller aborts the whole
 * sweep rather than marking everyone "left" on a partial result.
 */
export async function fetchParticipantIds(chatId: string): Promise<Set<number>> {
  const client = await getUserbot();
  const ids = new Set<number>();
  const entity = await client.getEntity(chatId);
  for await (const user of client.iterParticipants(entity, { limit: 500 })) {
    const id = Number(user.id);
    if (Number.isFinite(id) && id > 0) ids.add(id);
    if (ids.size >= PAGE_CAP) {
      logger.warn({ chatId, cap: PAGE_CAP }, 'participant cap reached; stopping enumeration');
      break;
    }
  }
  logger.info({ chatId, participants: ids.size }, 'participants enumerated');
  return ids;
}
