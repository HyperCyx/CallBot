/**
 * FreePBX integration contracts.
 *
 * SCOPE / HONESTY NOTE (spec §40, §43)
 * ==================================
 * Every method below maps 1:1 to an operation that IS documented in the
 * official Sangoma "PBX GUI - Core Module GraphQL APIs" / "CDR Module GraphQL
 * APIs" wiki pages, except where explicitly marked NOT CONFIRMED.
 *
 * Documented operations used here (verified against the wiki, links in
 * docs/05-freepbx-api-mapping.md):
 *
 *   addExtension, updateExtension, deleteExtension, fetchExtension,
 *   fetchAllExtensions, createRangeofExtension
 *   addInboundRoute, updateInboundRoute, removeInboundRoute,
 *   allInboundRoutes (query), inboundRoute(id) (query)
 *   addCoreDevice, updateCoreDevice, deleteCoreDevice, fetchCoreDevice,
 *   fetchAllCoreDevices
 *   fetchAllCdrs, fetchCdr
 *   fetchAdvanceSetting, fetchAllAdvanceSettings, updateAdvanceSettings
 *
 * NOT CONFIRMED in the official API documentation - deliberately NOT faked:
 *
 *   * Live/active call listing. There is no documented GraphQL query for
 *     "calls in progress". CDR is written after a call ends, so it can never
 *     be used as live data. Live calls therefore come from the Asterisk
 *     Manager Interface (AMI), the documented real-time interface, which is
 *     what `LiveCallSource` abstracts. See docs/06-did-routing.md §Live calls.
 *   * Trunk/DID provisioning at the carrier. The FreePBX API manages the PBX,
 *     not the upstream carrier's DID inventory. Carriers are integrated through
 *     `NumberProvider` (manual import is the default, supported out of the box).
 *   * CDR queries filtered by DID or by user. `fetchAllCdrs` supports only
 *     first/after/orderby/startDate/endDate, so per-user filtering is done in
 *     our own `call_history` mirror instead of pretending the PBX can do it.
 */

export type FreePBXTech = 'pjsip' | 'sip';

export interface FreePBXResult {
  status: boolean;
  message: string;
}

/** Payload for creating an extension. Mirrors documented `addExtension` input. */
export interface CreateExtensionInput {
  extensionId: string;
  name: string;
  tech?: FreePBXTech;
  email?: string;
  outboundCid?: string;
  emergencyCid?: string;
  callerId?: string;
  vmEnable?: boolean;
  vmPassword?: string;
  umEnable?: boolean;
  umGroups?: string;
  umPassword?: string;
  maxContacts?: number;
  clientMutationId?: string;
}

export interface UpdateExtensionInput extends Partial<Omit<CreateExtensionInput, 'extensionId'>> {
  extensionId: string;
  /**
   * Documented in the `updateExtension` input as "Set a secret/password for
   * extension". `addExtension` has NO password field, so the SIP secret is set
   * with a follow-up updateExtension call (see FreePBXClient.createExtension).
   */
  extPassword?: string;
}

export interface ExtensionUser {
  name?: string | null;
  outboundCid?: string | null;
  voicemail?: string | null;
  ringtimer?: number | null;
  noanswer?: string | null;
  noanswerDestination?: string | null;
  noanswerCid?: string | null;
  busyCid?: string | null;
  sipname?: string | null;
  password?: string | null;
  extPassword?: string | null;
}

export interface CoreDevice {
  deviceId?: string | null;
  dial?: string | null;
  devicetype?: string | null;
  description?: string | null;
  emergencyCid?: string | null;
  tech?: string | null;
  callerId?: string | null;
  sipdriver?: string | null;
}

export interface FreePBXExtension {
  id?: string | null;
  extensionId: string;
  user?: ExtensionUser | null;
  coreDevice?: CoreDevice | null;
}

/** Documented `addInboundRoute` / `updateInboundRoute` input. */
export interface InboundRouteInput {
  /** The DID (matching value). Empty string = "Any". */
  extension?: string;
  /** Caller ID pattern to match. Empty string = "Any". */
  cidnum?: string;
  description?: string;
  privacyman?: boolean;
  alertinfo?: string;
  ringing?: boolean;
  mohclass?: string;
  grppre?: string;
  delay_answer?: number;
  pricid?: boolean;
  pmmaxretries?: string;
  pmminlength?: string;
  reversal?: boolean;
  rvolume?: string;
  fanswer?: boolean;
  /** Destination, e.g. `from-did-direct,10194,1` (documented example format). */
  destination: string;
}

export interface UpdateInboundRouteInput extends InboundRouteInput {
  /** Required to rename an existing route (its identity is extension/cidnum). */
  oldExtension?: string;
  oldCidnum?: string;
}

export interface FreePBXInboundRoute {
  id: string;
  extension?: string | null;
  cidnum?: string | null;
  description?: string | null;
  privacyman?: boolean | null;
  alertinfo?: string | null;
  ringing?: boolean | null;
  mohclass?: string | null;
  grppre?: string | null;
  delay_answer?: number | null;
  pricid?: boolean | null;
  pmmaxretries?: number | null;
  pmminlength?: number | null;
  reversal?: boolean | null;
  rvolume?: number | null;
  fanswer?: boolean | null;
  /**
   * The PBX returns a human readable string here, e.g.
   * "Extensions: 4001 Extension 4001" - NOT the raw dialplan destination.
   * The raw destination we sent is tracked in the DB, and drift detection
   * compares the extension part of this string.
   */
  destinationConnection?: string | null;
}

export interface CdrRecord {
  id: string;
  uniqueid: string;
  calldate: string;
  timestamp?: number | null;
  clid?: string | null;
  src?: string | null;
  dst?: string | null;
  dcontext?: string | null;
  channel?: string | null;
  dstchannel?: string | null;
  lastapp?: string | null;
  lastdata?: string | null;
  duration?: number | null;
  billsec?: number | null;
  disposition?: string | null;
  accountcode?: string | null;
  userfield?: string | null;
  did?: string | null;
  recordingfile?: string | null;
  cnum?: string | null;
  outbound_cnum?: string | null;
  outbound_cnam?: string | null;
  dst_cnam?: string | null;
  linkedid?: string | null;
  peeraccount?: string | null;
  sequence?: string | null;
  amaflags?: string | null;
}

export interface CdrQuery {
  first?: number;
  after?: number;
  orderby?: 'duration' | 'date';
  startDate?: string; // YYYY-MM-DD
  endDate?: string;   // YYYY-MM-DD
}

export interface CdrPage {
  cdrs: CdrRecord[];
  totalCount: number;
  status: boolean;
  message: string;
}

export interface PbxVersionInfo {
  pbxVersion: string | null;
  asteriskVersion: string | null;
  apiModuleVersion: string | null;
}

/**
 * The interface every PBX backend implements. The mock client used for
 * development/tests implements exactly the same contract, so the rest of the
 * application is unaware of which one is active (spec §30, §41).
 */
export interface FreePBXBackend {
  readonly kind: 'graphql' | 'mock';
  authenticate(): Promise<void>;
  /** Cheap "is the PBX reachable and are our scopes valid" probe. */
  ping(): Promise<{ ok: boolean; detail?: string }>;
  detectVersion(): Promise<PbxVersionInfo>;

  createExtension(input: CreateExtensionInput, opts?: { sipPassword?: string }): Promise<FreePBXResult & { extensionId: string; sipPassword?: string }>;
  updateExtension(input: UpdateExtensionInput): Promise<FreePBXResult & { extensionId: string }>;
  deleteExtension(extensionId: string): Promise<FreePBXResult>;
  getExtension(extensionId: string): Promise<FreePBXExtension | null>;
  getAllExtensions(): Promise<FreePBXExtension[]>;
  createExtensionRange(startExtension: string, numberOfExtensions: number, opts?: { name?: string; tech?: FreePBXTech }): Promise<FreePBXResult>;

  createInboundRoute(input: InboundRouteInput): Promise<FreePBXResult & { routeId: string }>;
  updateInboundRoute(input: UpdateInboundRouteInput): Promise<FreePBXResult & { routeId: string }>;
  deleteInboundRoute(routeId: string): Promise<FreePBXResult>;
  getInboundRoute(routeId: string): Promise<FreePBXInboundRoute | null>;
  getAllInboundRoutes(): Promise<FreePBXInboundRoute[]>;

  getCdrs(query: CdrQuery): Promise<CdrPage>;
  getCdr(id: string): Promise<CdrRecord | null>;
}

/** Error taxonomy so callers can decide between retry / user error / escalation. */
export class FreePBXError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | 'AUTH'
      | 'NETWORK'
      | 'TIMEOUT'
      | 'GRAPHQL'
      | 'REJECTED'
      | 'UNSUPPORTED'
      | 'NOT_FOUND'
      | 'CONFIG',
    public readonly detail?: { httpStatus?: number; errors?: unknown; operation?: string },
  ) {
    super(message);
    this.name = 'FreePBXError';
  }

  /** Safe to retry (transient). Rejected/unsupported are NOT retried. */
  get retryable(): boolean {
    return this.kind === 'NETWORK' || this.kind === 'TIMEOUT' || this.kind === 'AUTH';
  }
}

/** Live-call source (AMI). Kept separate from the GraphQL backend by design. */
export interface LiveCall {
  channel: string;
  uniqueid?: string;
  linkedid?: string;
  caller: string;
  connectedTo?: string;
  did?: string;
  extension?: string;
  state: string;
  direction: 'INBOUND' | 'OUTBOUND' | 'INTERNAL' | 'UNKNOWN';
  startedAt: Date;
  answeredAt?: Date;
  lastEventAt: Date;
}

export interface LiveCallSource {
  readonly kind: 'ami' | 'disabled';
  /** Current snapshot of active channels. */
  listActiveCalls(): Promise<LiveCall[]>;
  /** AMI-only convenience: `core show version` (compat probe); absent on the disabled source. */
  coreShowVersion?(): Promise<string | null>;
  /** Registers a listener for incremental events (used to keep call_sessions fresh). */
  subscribe(handler: (event: LiveCallEvent) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): { connected: boolean; detail?: string };
}

export type LiveCallEvent =
  | { type: 'channel_new'; call: LiveCall }
  | { type: 'channel_state'; call: LiveCall }
  | { type: 'channel_hangup'; channel: string; uniqueid?: string; cause?: string };
