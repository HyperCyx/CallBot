import { randomUUID } from 'node:crypto';
import { generateSipPassword } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import {
  FreePBXError,
  type CdrPage,
  type CdrQuery,
  type CdrRecord,
  type CreateExtensionInput,
  type FreePBXBackend,
  type FreePBXExtension,
  type FreePBXInboundRoute,
  type FreePBXResult,
  type FreePBXTech,
  type InboundRouteInput,
  type PbxVersionInfo,
  type UpdateExtensionInput,
  type UpdateInboundRouteInput,
} from './types.js';

/**
 * Deterministic in-memory FreePBX double.
 *
 * Purpose (spec §39, §41):
 *   * lets the whole platform - bot, API, workers, integration tests - run
 *     without a PBX, which is how the concurrency and failure tests are run in
 *     CI;
 *   * models the real FreePBX semantics that matter to us: extension creation,
 *     the composite inbound-route id `<extension>/<cidnum>`, route updates
 *     needing the OLD identity, CDR paging by first/after.
 *
 * It is NOT a fake that hides problems: failures can be injected explicitly
 * (`failNextOperation`) so the rollback paths in the assignment service are
 * exercised for real.
 */

export interface MockPbxState {
  extensions: Map<string, FreePBXExtension & { sipPassword: string }>;
  routes: Map<string, FreePBXInboundRoute>;
  cdrs: CdrRecord[];
  /** operation name -> number of times to fail before succeeding */
  failures: Map<string, { remaining: number; message: string; kind: FreePBXError['kind'] }>;
  calls: Array<Record<string, unknown>>;
}

export class MockFreePBXClient implements FreePBXBackend {
  readonly kind = 'mock' as const;
  readonly state: MockPbxState = {
    extensions: new Map(),
    routes: new Map(),
    cdrs: [],
    failures: new Map(),
    calls: [],
  };

  /** Queue N failures for an operation; `reset()` clears them. */
  failNextOperation(operation: string, times = 1, message = 'injected failure', kind: FreePBXError['kind'] = 'NETWORK'): void {
    this.state.failures.set(operation, { remaining: times, message, kind });
  }

  reset(): void {
    this.state.extensions.clear();
    this.state.routes.clear();
    this.state.cdrs = [];
    this.state.failures.clear();
    this.state.calls = [];
  }

  private maybeFail(operation: string): void {
    const f = this.state.failures.get(operation);
    if (!f || f.remaining <= 0) return;
    f.remaining -= 1;
    if (f.remaining <= 0) this.state.failures.delete(operation);
    throw new FreePBXError(`[mock] ${operation}: ${f.message}`, f.kind, { operation });
  }

  private routeId(extension: string, cidnum: string): string {
    // Documented FreePBX inbound route identity: "<extension>/<cidnum>".
    return `${extension}/${cidnum}`;
  }

  async authenticate(): Promise<void> {
    this.maybeFail('authenticate');
  }

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: 'mock pbx' };
  }

  async detectVersion(): Promise<PbxVersionInfo> {
    return { pbxVersion: '17.0 (mock)', asteriskVersion: '20.5 (mock)', apiModuleVersion: 'mock-1.0' };
  }

  // --- extensions ------------------------------------------------------------

  async createExtension(
    input: CreateExtensionInput,
    opts: { sipPassword?: string } = {},
  ): Promise<FreePBXResult & { extensionId: string; sipPassword?: string }> {
    this.maybeFail('addExtension');
    if (this.state.extensions.has(input.extensionId)) {
      throw new FreePBXError(`Extension ${input.extensionId} already exists`, 'REJECTED', { operation: 'addExtension' });
    }
    const sipPassword = opts.sipPassword ?? generateSipPassword();
    this.state.extensions.set(input.extensionId, {
      id: `ZXh0ZW5zaW9uOiR7${input.extensionId}}`,
      extensionId: input.extensionId,
      user: { name: input.name, outboundCid: input.outboundCid ?? '', sipname: '', password: '', extPassword: sipPassword },
      coreDevice: {
        deviceId: input.extensionId,
        dial: `PJSIP/${input.extensionId}`,
        devicetype: 'fixed',
        description: input.name,
        tech: input.tech ?? 'pjsip',
      },
      sipPassword,
    });
    logger.debug({ extension: input.extensionId }, '[mock] addExtension');
    return { status: true, message: 'Extension has been created Successfully', extensionId: input.extensionId, sipPassword };
  }

  async updateExtension(input: UpdateExtensionInput): Promise<FreePBXResult & { extensionId: string }> {
    this.maybeFail('updateExtension');
    const existing = this.state.extensions.get(input.extensionId);
    if (!existing) throw new FreePBXError(`Extension ${input.extensionId} not found`, 'NOT_FOUND', { operation: 'updateExtension' });
    if (input.extPassword) {
      existing.sipPassword = input.extPassword;
      existing.user = { ...existing.user, extPassword: input.extPassword };
    }
    if (input.name) {
      existing.user = { ...existing.user, name: input.name };
      existing.coreDevice = { ...existing.coreDevice, description: input.name };
    }
    this.state.extensions.set(input.extensionId, existing);
    return { status: true, message: 'Extension has been updated', extensionId: input.extensionId };
  }

  async deleteExtension(extensionId: string): Promise<FreePBXResult> {
    this.maybeFail('deleteExtension');
    if (!this.state.extensions.delete(extensionId)) {
      throw new FreePBXError(`Extension ${extensionId} not found`, 'NOT_FOUND', { operation: 'deleteExtension' });
    }
    // FreePBX also removes routes that point at the deleted extension; mirror that
    // so the reconciler can be tested against realistic behaviour.
    for (const [id, route] of [...this.state.routes]) {
      if (route.destinationConnection?.includes(extensionId)) this.state.routes.delete(id);
    }
    return { status: true, message: 'Extension has been deleted' };
  }

  async getExtension(extensionId: string): Promise<FreePBXExtension | null> {
    this.maybeFail('fetchExtension');
    return this.state.extensions.get(extensionId) ?? null;
  }

  async getAllExtensions(): Promise<FreePBXExtension[]> {
    this.maybeFail('fetchAllExtensions');
    return [...this.state.extensions.values()];
  }

  async createExtensionRange(startExtension: string, numberOfExtensions: number, opts: { name?: string; tech?: FreePBXTech } = {}): Promise<FreePBXResult> {
    this.maybeFail('createRangeofExtension');
    const start = Number(startExtension);
    for (let i = 0; i < numberOfExtensions; i += 1) {
      await this.createExtension({
        extensionId: String(start + i),
        name: `${opts.name ?? 'sipbot'} ${start + i}`,
        tech: opts.tech ?? 'pjsip',
      });
    }
    return { status: true, message: "Extension's has been created Successfully" };
  }

  // --- inbound routes --------------------------------------------------------

  async createInboundRoute(input: InboundRouteInput): Promise<FreePBXResult & { routeId: string }> {
    this.maybeFail('addInboundRoute');
    const id = this.routeId(input.extension ?? '', input.cidnum ?? '');
    if (this.state.routes.has(id)) {
      throw new FreePBXError(`Inbound route ${id} already exists`, 'REJECTED', { operation: 'addInboundRoute' });
    }
    this.state.routes.set(id, {
      id,
      extension: input.extension ?? '',
      cidnum: input.cidnum ?? '',
      description: input.description ?? null,
      destinationConnection: `Extensions: ${(input.destination.split(',')[1] ?? '').trim()} Extension`,
      ...(input.ringing !== undefined ? { ringing: input.ringing } : {}),
    });
    return { status: true, message: 'Inbound Route created successfully', routeId: id };
  }

  async updateInboundRoute(input: UpdateInboundRouteInput): Promise<FreePBXResult & { routeId: string }> {
    this.maybeFail('updateInboundRoute');
    const oldId = this.routeId(input.oldExtension ?? input.extension ?? '', input.oldCidnum ?? input.cidnum ?? '');
    const existing = this.state.routes.get(oldId);
    if (!existing) throw new FreePBXError(`Inbound route ${oldId} not found`, 'NOT_FOUND', { operation: 'updateInboundRoute' });
    this.state.routes.delete(oldId);
    const newId = this.routeId(input.extension ?? '', input.cidnum ?? '');
    this.state.routes.set(newId, {
      ...existing,
      id: newId,
      extension: input.extension ?? existing.extension,
      cidnum: input.cidnum ?? existing.cidnum,
      destinationConnection: `Extensions: ${(input.destination.split(',')[1] ?? '').trim()} Extension`,
    });
    return { status: true, message: 'Inbound Route updated successfully', routeId: newId };
  }

  async deleteInboundRoute(routeId: string): Promise<FreePBXResult> {
    this.maybeFail('removeInboundRoute');
    if (!this.state.routes.delete(routeId)) {
      throw new FreePBXError(`Inbound route ${routeId} not found`, 'NOT_FOUND', { operation: 'removeInboundRoute' });
    }
    return { status: true, message: 'Inbound Route deleted successfully' };
  }

  async getInboundRoute(routeId: string): Promise<FreePBXInboundRoute | null> {
    this.maybeFail('inboundRoute');
    return this.state.routes.get(routeId) ?? null;
  }

  async getAllInboundRoutes(): Promise<FreePBXInboundRoute[]> {
    this.maybeFail('allInboundRoutes');
    return [...this.state.routes.values()];
  }

  // --- CDR -------------------------------------------------------------------

  /** Test helper: record a finished call in the mock CDR table. */
  addCdr(partial: Partial<CdrRecord> & { src: string; dst: string }): CdrRecord {
    const record: CdrRecord = {
      id: randomUUID(),
      uniqueid: partial.uniqueid ?? `${Date.now()}.${Math.floor(Math.random() * 1000)}`,
      calldate: partial.calldate ?? new Date().toISOString().slice(0, 19).replace('T', ' '),
      duration: partial.duration ?? 42,
      billsec: partial.billsec ?? 30,
      disposition: partial.disposition ?? 'ANSWERED',
      did: partial.did ?? '',
      ...partial,
    } as CdrRecord;
    this.state.cdrs.push(record);
    return record;
  }

  async getCdrs(query: CdrQuery): Promise<CdrPage> {
    this.maybeFail('fetchAllCdrs');
    const first = query.first ?? 100;
    const after = query.after ?? 0;
    let rows = [...this.state.cdrs];
    if (query.startDate) rows = rows.filter((r) => r.calldate >= `${query.startDate} 00:00:00`);
    if (query.endDate) rows = rows.filter((r) => r.calldate <= `${query.endDate} 23:59:59`);
    if (query.orderby === 'duration') rows.sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
    else rows.sort((a, b) => String(b.calldate).localeCompare(String(a.calldate)));
    return {
      cdrs: rows.slice(after, after + first),
      totalCount: rows.length,
      status: true,
      message: 'CDR data found successfully',
    };
  }

  async getCdr(id: string): Promise<CdrRecord | null> {
    this.maybeFail('fetchCdr');
    return this.state.cdrs.find((c) => c.id === id) ?? null;
  }
}
