import net from 'node:net';
import tls from 'node:tls';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { sleep } from '../lib/time.js';
import type { LiveCall, LiveCallEvent, LiveCallSource } from './types.js';

/**
 * Asterisk Manager Interface client - the source for LIVE calls.
 *
 * WHY AMI AND NOT CDR (spec §20, §40)
 * -----------------------------------
 * The Sangoma PBX GUI GraphQL API documents CDR retrieval (`fetchAllCdrs`,
 * `fetchCdr`) but no "calls currently in progress" query, and CDR rows are only
 * written when a call ends. Therefore:
 *
 *   * live call monitoring  -> AMI events / CoreShowChannels  (this file)
 *   * historical call data  -> documented CDR GraphQL queries (freepbx/client.ts)
 *
 * The two are stored in separate tables (call_sessions vs call_history) and are
 * never presented as if they were the same thing.
 *
 * The AMI protocol is a documented, plain-text protocol: `Action: <name>` lines
 * followed by parameters, terminated by an empty line; responses and events are
 * `Key: Value` packets terminated by an empty line. Parsing is implemented here
 * (and unit-tested) rather than pulling in an unmaintained dependency for the
 * credential-bearing connection.
 */

export interface AmiPacket {
  [key: string]: string | undefined;
}

/** Parses one or more AMI packets out of a raw chunk buffer. */
export function parseAmiPackets(raw: string): { packets: AmiPacket[]; remainder: string } {
  const packets: AmiPacket[] = [];
  let remainder = raw;

  // Packets are separated by a blank line. Asterisk uses \r\n; be liberal.
  let idx = remainder.search(/\r?\n\r?\n/);
  while (idx !== -1) {
    const block = remainder.slice(0, idx);
    const sepMatch = remainder.slice(idx).match(/^\r?\n\r?\n/);
    remainder = remainder.slice(idx + (sepMatch ? sepMatch[0].length : 2));

    const packet: AmiPacket = {};
    for (const line of block.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      // Repeated keys (rare) are concatenated, matching AMI semantics.
      packet[key] = packet[key] ? `${packet[key]}\n${value}` : value;
    }
    if (Object.keys(packet).length > 0) packets.push(packet);
    idx = remainder.search(/\r?\n\r?\n/);
  }
  return { packets, remainder };
}

/** Channel name -> the Info suffix, e.g. "PJSIP/10194-0000001c" -> "10194". */
export function extractPeerFromChannel(channel: string | undefined): string | null {
  if (!channel) return null;
  const withoutTech = channel.includes('/') ? channel.split('/')[1] ?? '' : channel;
  const withoutSuffix = withoutTech.split('-')[0] ?? '';
  return withoutSuffix || null;
}

interface ActiveChannel {
  call: LiveCall;
}

export interface AmiClientOptions {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  secret: string;
  tls: boolean;
  tlsVerify: boolean;
  /**
   * Pre-login watchdog: max time to wait for the AMI banner / login reply.
   * A stateful NAT or firewall in front of the PBX can ACK the TCP handshake
   * and then silently drop every packet - without this watchdog the socket
   * sits half-open forever and the status screen claims "connected" while
   * nothing works. Post-login the timeout is disabled and a periodic Ping
   * takes over (an idle channel list can legitimately be silent for hours).
   */
  watchdogMs: number;
  /** Post-login keepalive interval: one Ping action this often; a failed Ping drops the socket so the close handler reconnects. */
  pingIntervalMs: number;
}

export class AmiClient implements LiveCallSource {
  readonly kind = 'ami' as const;
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = '';
  private connected = false;
  private connecting: Promise<void> | null = null;
  private actionCounter = 0;
  private pending = new Map<string, { resolve: (p: AmiPacket) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private active = new Map<string, ActiveChannel>();
  private handlers: Array<(e: LiveCallEvent) => void> = [];
  private stopped = false;
  private lastError: string | undefined;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private networkFailures = 0;

  constructor(private readonly opts: AmiClientOptions = {
    enabled: env.ami.enabled,
    host: env.ami.host,
    port: env.ami.port,
    user: env.ami.user,
    secret: env.ami.secret,
    tls: env.ami.tls,
    tlsVerify: env.ami.tlsVerify,
    watchdogMs: 15_000,
    pingIntervalMs: 30_000,
  }) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (!this.opts.enabled) {
      logger.info('AMI disabled: live call monitoring will report as unavailable');
      return;
    }
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('AMI client stopped'));
    }
    this.pending.clear();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.end();
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.active.clear();
  }

  status(): { connected: boolean; detail?: string } {
    const detail = this.lastError ?? (!this.connected && this.connecting ? `retrying connection to ${this.opts.host}:${this.opts.port}…` : undefined);
    return { connected: this.connected, ...(detail ? { detail } : {}) };
  }

  subscribe(handler: (event: LiveCallEvent) => void): void {
    this.handlers.push(handler);
  }

  private emit(event: LiveCallEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'AMI event handler threw');
      }
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.stopped) return;
      this.send('Action: Ping').catch((err: Error) => {
        if (this.stopped) return;
        this.lastError = `AMI keepalive failed: ${err.message}`;
        logger.warn({ err: err.message }, 'AMI ping failed; dropping the connection so it reconnects');
        this.socket?.destroy();
      });
    }, this.opts.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    if (this.connecting) return this.connecting;
    // Fresh attempt, fresh diagnosis; the first error of THIS attempt sticks.
    this.lastError = undefined;
    this.connecting = (async () => {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (err?: Error): void => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve();
        };

        const onReady = (): void => {
          // The TCP handshake alone proves nothing (a SYN-proxying middlebox
          // fakes one for every port) - only a successful Login marks the
          // session connected. Watchdog stays armed until then.
          this.send('Action: Login', {
            Username: this.opts.user,
            Secret: this.opts.secret,
            Events: 'on',
          })
            .then((res) => {
              if (res.Response === 'Success') {
                this.connected = true;
                this.networkFailures = 0;
                this.lastError = undefined;
                this.socket?.setTimeout(0);
                this.startPing();
                logger.info({ host: this.opts.host, port: this.opts.port }, 'AMI connected');
                settle();
              } else {
                this.lastError = `AMI login rejected by the PBX: ${res.Message ?? 'unknown'}`;
                logger.error({ err: this.lastError }, 'AMI login failed');
                this.socket?.destroy();
                settle(new Error(this.lastError));
              }
            })
            .catch((err: Error) => {
              // The 'close'/'timeout' handlers run first and carry the better
              // diagnosis ("connection closed"/timeout-awaiting-pending is the
              // SYMPTOM, not the cause) - do not let the pending Login's
              // rejection clobber it.
              this.lastError ??= err.message;
              this.socket?.destroy();
              settle(err);
            });
        };

        this.socket = this.opts.tls
          ? tls.connect({ host: this.opts.host, port: this.opts.port, rejectUnauthorized: this.opts.tlsVerify })
          : net.connect({ host: this.opts.host, port: this.opts.port });

        let ready = false;
        this.socket.setEncoding('utf8');
        this.socket.setTimeout(this.opts.watchdogMs);
        const armReady = (): void => {
          if (ready) return;
          ready = true;
          onReady();
        };
        this.socket.on('connect', armReady);
        this.socket.on('secureConnect', armReady);
        this.socket.on('timeout', () => {
          this.lastError =
            `AMI at ${this.opts.host}:${this.opts.port} accepted the connection but never answered (no banner/login reply). ` +
            'A firewall or NAT in front of the PBX is silently dropping the traffic - check the Asterisk manager bind address and the 5038 port mapping/ACL.';
          logger.warn(this.lastError);
          this.socket?.destroy();
          settle(new Error(this.lastError));
        });
        this.socket.on('data', (chunk: string) => this.onData(chunk));
        this.socket.on('error', (err) => {
          this.lastError ??= err.message;
          logger.error({ err: err.message }, 'AMI socket error');
          settle(err);
        });
        this.socket.on('close', () => {
          this.connected = false;
          this.stopPing();
          for (const [key, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error('AMI connection closed'));
            this.pending.delete(key);
          }
          if (!this.stopped) {
            // A rejected auth never fixes itself on a timer - the operator has
            // to change the account on the PBX (FreePBX intrusion detection
            // WILL ban us for hammering bad logins; the 2026-10-08 incident
            // cost us the whole egress IP, GraphQL included). Poll gently
            // every 5 min so the moment the fix lands we recover on our own.
            // Network faults back off exponentially (5s -> 5min cap): during a
            // ban/outage window a flat 5s storm is pure perimeter noise and
            // log spam, and any real recovery is detected on the next probe.
            this.networkFailures += 1;
            const delay = this.lastError?.startsWith('AMI login rejected')
              ? 300_000
              : Math.min(300_000, 5_000 * 2 ** Math.min(this.networkFailures, 5));
            logger.warn({ retryInMs: delay }, 'AMI connection closed; reconnecting');
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              if (this.stopped) return;
              this.connect().catch((err) => logger.error({ err: (err as Error).message }, 'AMI reconnect attempt failed'));
            }, delay);
          }
        });
      });
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  // ---------------------------------------------------------------------------
  // Protocol
  // ---------------------------------------------------------------------------

  private onData(chunk: string): void {
    this.buffer += chunk;
    const { packets, remainder } = parseAmiPackets(this.buffer);
    this.buffer = remainder;
    for (const packet of packets) {
      if (packet.ActionID && this.pending.has(packet.ActionID)) {
        const entry = this.pending.get(packet.ActionID)!;
        if (packet.Response !== 'Follows') {
          // 'Follows' means a multi-line body block (e.g. CoreShowChannels);
          // the terminal packet always has Response: Success.
          if (packet.Response && packet.Response !== 'Follows') {
            clearTimeout(entry.timer);
            this.pending.delete(packet.ActionID);
            entry.resolve(packet);
          }
        }
        continue;
      }
      this.handleEvent(packet);
    }
  }

  private async send(actionLine: string, params: Record<string, string> = {}, timeoutMs = 8_000): Promise<AmiPacket> {
    // Gate on the socket, not on `connected`: the Login action itself is sent
    // before the session is authenticated and marked connected.
    if (!this.socket || this.socket.destroyed) throw new Error('AMI not connected');
    this.actionCounter += 1;
    const actionId = `sipbot-${Date.now()}-${this.actionCounter}`;
    const lines = [actionLine, `ActionID: ${actionId}`, ...Object.entries(params).map(([k, v]) => `${k}: ${v}`), ''];
    const payload = `${lines.join('\r\n')}\r\n`;

    return new Promise<AmiPacket>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(actionId);
        reject(new Error(`AMI action timed out: ${actionLine}`));
      }, timeoutMs);
      this.pending.set(actionId, { resolve, reject, timer });
      this.socket!.write(payload);
    });
  }

  private handleEvent(packet: AmiPacket): void {
    const event = packet.Event;
    if (!event) return;
    const now = new Date();

    switch (event) {
      case 'Newchannel': {
        const channel = packet.Channel ?? '';
        if (!channel) return;
        const peer = extractPeerFromChannel(channel);
        const direction = this.classifyDirection(packet);
        const call: LiveCall = {
          channel,
          ...(packet.Uniqueid ? { uniqueid: packet.Uniqueid } : {}),
          ...(packet.Linkedid ? { linkedid: packet.Linkedid } : {}),
          caller: packet.CallerIDNum ?? '',
          ...(packet.Exten ? { connectedTo: packet.Exten } : {}),
          ...(direction === 'INBOUND' && peer ? { did: packet.Exten ?? undefined } : {}),
          ...(peer ? { extension: peer } : {}),
          state: packet.ChannelStateDesc ?? 'New',
          direction,
          startedAt: now,
          lastEventAt: now,
        };
        this.active.set(channel, { call });
        this.emit({ type: 'channel_new', call });
        break;
      }
      case 'Newstate':
      case 'NewConnectedLine': {
        const channel = packet.Channel ?? '';
        const entry = this.active.get(channel);
        if (!entry) return;
        entry.call.state = packet.ChannelStateDesc ?? entry.call.state;
        entry.call.lastEventAt = now;
        if (entry.call.state === 'Up' && !entry.call.answeredAt) entry.call.answeredAt = now;
        if (packet.ConnectedLineNum) entry.call.connectedTo = packet.ConnectedLineNum;
        this.emit({ type: 'channel_state', call: entry.call });
        break;
      }
      case 'Dial': {
        const channel = packet.Channel ?? '';
        const dest = packet.Destination ?? '';
        const destPeer = extractPeerFromChannel(dest);
        const entry = this.active.get(channel);
        if (entry && destPeer) {
          entry.call.connectedTo = destPeer;
          entry.call.extension = destPeer;
          entry.call.lastEventAt = now;
          this.emit({ type: 'channel_state', call: entry.call });
        }
        break;
      }
      case 'Bridge': {
        const a = packet.Channel1;
        const b = packet.Channel2;
        for (const ch of [a, b]) {
          if (!ch) continue;
          const entry = this.active.get(ch);
          if (entry) {
            entry.call.answeredAt ??= now;
            entry.call.lastEventAt = now;
          }
        }
        break;
      }
      case 'Hangup': {
        const channel = packet.Channel ?? '';
        const entry = this.active.get(channel);
        this.active.delete(channel);
        this.emit({
          type: 'channel_hangup',
          channel,
          ...(entry?.call.uniqueid ? { uniqueid: entry.call.uniqueid } : {}),
          ...(packet.Cause ? { cause: packet.Cause } : {}),
        });
        break;
      }
      default:
        // Other events (VarSet, PeerStatus, ...) are ignored on purpose.
        break;
    }
  }

  /**
   * Classifies a channel as inbound/outbound/internal from the context/dialplan
   * data. FreePBX inbound calls arrive in `from-trunk`/`from-pstn`; outbound
   * calls come from `from-internal` towards a trunk.
   */
  private classifyDirection(packet: AmiPacket): LiveCall['direction'] {
    const ctx = `${packet.Context ?? ''} ${packet.Channel ?? ''}`;
    if (/from-trunk|from-pstn|from-did|from-external/i.test(ctx)) return 'INBOUND';
    if (/from-internal/i.test(ctx)) return 'INTERNAL';
    if (/trunk/i.test(packet.Channel ?? '')) return 'OUTBOUND';
    return 'UNKNOWN';
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Snapshot of active channels.
   *
   * Uses the AMI `CoreShowChannels` action, which reports channels that are
   * currently up. The cached event view is merged in so that channels which are
   * still ringing (and therefore not yet "up") are shown as Ringing instead of
   * silently missing.
   */
  async listActiveCalls(): Promise<LiveCall[]> {
    if (!this.opts.enabled || !this.connected) {
      // Degrade honestly: report what the event stream knows, flag nothing as
      // authoritative. Callers surface "live monitoring unavailable".
      if (!this.opts.enabled) return [];
      return [...this.active.values()].map((a) => a.call);
    }

    try {
      const res = await this.send('Action: CoreShowChannels');
      const channels = (res.Channels ?? '')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          // "PJSIP/10194-0000001c!10194!1!Up!..."
          const [channel, exten, , state] = line.split('!');
          return { channel: channel ?? '', exten, state };
        });

      const merged = new Map<string, LiveCall>();
      for (const { channel, exten, state } of channels) {
        const cached = this.active.get(channel);
        if (cached) {
          merged.set(channel, { ...cached.call, state: state ?? cached.call.state });
        } else {
          const peer = extractPeerFromChannel(channel);
          merged.set(channel, {
            channel,
            caller: '',
            ...(exten ? { connectedTo: exten } : {}),
            ...(peer ? { extension: peer } : {}),
            state: state ?? 'Up',
            direction: 'UNKNOWN',
            startedAt: new Date(),
            lastEventAt: new Date(),
          });
        }
      }
      // Add ringing channels from the cache that CoreShowChannels does not list.
      for (const [channel, entry] of this.active) {
        if (!merged.has(channel)) merged.set(channel, entry.call);
      }
      return [...merged.values()];
    } catch (err) {
      this.lastError = (err as Error).message;
      logger.warn({ err: (err as Error).message }, 'CoreShowChannels failed; using cached event state');
      // Brief retry loop is intentional: a busy PBX can be slow to answer.
      await sleep(50);
      return [...this.active.values()].map((a) => a.call);
    }
  }

  /** Convenience for the version probe (§41): `core show version` over AMI. */
  async coreShowVersion(): Promise<string | null> {
    if (!this.opts.enabled || !this.connected) return null;
    try {
      const res = await this.send('Action: Command', { Command: 'core show version' });
      return res.Output ?? null;
    } catch {
      return null;
    }
  }
}

/** A LiveCallSource used when AMI is disabled or unconfigured. */
export class DisabledLiveCallSource implements LiveCallSource {
  readonly kind = 'disabled' as const;
  async listActiveCalls(): Promise<LiveCall[]> {
    return [];
  }
  subscribe(): void {
    /* no-op */
  }
  async start(): Promise<void> {
    /* no-op */
  }
  async stop(): Promise<void> {
    /* no-op */
  }
  status(): { connected: boolean; detail?: string } {
    return { connected: false, detail: 'AMI is disabled (set AMI_ENABLED=true and AMI_USER/AMI_SECRET)' };
  }
}
