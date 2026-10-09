/**
 * Thin adapter: membership audit core (pure, tested) + the real userbot
 * participant fetcher (GramJS - never imported by tests).
 */
import { fetchParticipantIds } from '../userbot/participants.js';
import { runMembershipSweep, type SweepSummary } from '../services/membershipAudit.service.js';

export async function runSweepWithUserbot(): Promise<SweepSummary> {
  return runMembershipSweep(fetchParticipantIds);
}
