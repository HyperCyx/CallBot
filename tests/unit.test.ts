import { notificationButtons } from '../src/workers/index.js';
import { sanitizeDid, applyInboundRoute } from '../src/services/routing.service.js';
import { createTelegramSender } from '../src/workers/telegramSender.js';
import { addNumbersToInventory, getRouteForNumber, mockPbx } from './helpers.js';
import { createWakeScheduler } from '../src/workers/notification-listener.js';
import { isTransientPgConnectionError } from '../src/db/pool.js';
import { describe, expect, it, vi } from 'vitest';
import { FreePBXGraphQLClient, coerceScalar, extractUnsupportedFields, stripFields } from '../src/freepbx/client.js';
import { FreePBXError } from '../src/freepbx/types.js';
import {
  InvalidPhoneNumberError,
  dialCodeOf,
  didCandidates,
  didMatch,
  isInExtensionRange,
  isValidE164,
  isValidExtension,
  normalizeE164,
  prettyNumber,
} from '../src/lib/phone.js';
import {
  decryptSecret,
  encryptSecret,
  generateNumericCode,
  generateReferralCode,
  generateSipPassword,
  hmac,
  isEncrypted,
  safeEqual,
} from '../src/lib/crypto.js';
import { AppError, badInput, forbidden, notFound, rateLimited, toAppError } from '../src/lib/errors.js';
import { RateLimiter } from '../src/lib/rate-limit.js';
import { parseNumberCsv } from '../src/services/inventory.service.js';
import { scrubMetadata } from '../src/services/audit.service.js';

/**
 * Pure unit tests (no database).
 *
 * These cover the primitives every other layer depends on: number
 * normalisation/DID matching (spec §14 inbound routing), secret encryption
 * (spec §33), the failure taxonomy (spec §36), the sliding-window limiter
 * (spec §37), CSV parsing (spec §13) and audit metadata scrubbing (spec §34).
 */

describe('phone helpers (spec §14 DID matching)', () => {
  it('normalises the forms users actually type', () => {
    expect(normalizeE164('+971 50 123 4567').e164).toBe('+971501234567');
    expect(normalizeE164('00971501234567').e164).toBe('+971501234567');
    expect(normalizeE164('(971) 50-123-4567').e164).toBe('+971501234567');
    expect(normalizeE164('+971.50.123.4567').e164).toBe('+971501234567');
  });

  it('applies the caller country dial code only when no international prefix is given', () => {
    expect(normalizeE164('0501234567', '971').e164).toBe('+971501234567');
    // Already carries the dial code: not doubled.
    expect(normalizeE164('971501234567', '971').e164).toBe('+971501234567');
    // Explicit '+': the default dial code must be ignored.
    expect(normalizeE164('+15045043535', '971').e164).toBe('+15045043535');
  });

  it('rejects empty and impossible inputs instead of silently mangling them', () => {
    expect(() => normalizeE164('')).toThrow(InvalidPhoneNumberError);
    expect(() => normalizeE164('call me maybe')).toThrow(InvalidPhoneNumberError);
    expect(() => normalizeE164('+1234')).toThrow(InvalidPhoneNumberError);
    expect(isValidE164('+971501234567')).toBe(true);
    expect(isValidE164('971501234567')).toBe(false);
  });

  it('derives the FreePBX match pattern and the reconciliation candidate list', () => {
    expect(didMatch('+971501234567')).toBe('971501234567');
    const candidates = didCandidates('+971501234567');
    expect(candidates[0]).toBe('971501234567');
    expect(candidates).toContain('+971501234567');
    expect(candidates).toContain('00971501234567');
    // NANP trunks often deliver 10 digits when the country code is stripped.
    expect(didCandidates('+15045043535')).toContain('5045043535');
  });

  it('extracts dial codes for display and formats numbers', () => {
    expect(dialCodeOf('+971501234567')).toBe('971');
    expect(dialCodeOf('+14155552671')).toBe('1');
    expect(dialCodeOf('+442071234567')).toBe('44');
    expect(prettyNumber('971501234567')).toBe('+971501234567');
    expect(prettyNumber('+971501234567')).toBe('+971501234567');
  });

  it('validates extensions against the configured allocation range', () => {
    expect(isValidExtension('10000')).toBe(true);
    expect(isValidExtension('1')).toBe(false);
    expect(isValidExtension('ext12')).toBe(false);
    expect(isInExtensionRange('10000')).toBe(true);
    expect(isInExtensionRange('9999')).toBe(false);
    expect(isInExtensionRange('99999')).toBe(false);
  });
});

describe('secret encryption at rest (spec §33)', () => {
  it('round-trips a SIP password', () => {
    const secret = 'Sup3r-Secret-Sip-P@ss';
    const stored = encryptSecret(secret);
    expect(stored).not.toContain(secret);
    expect(isEncrypted(stored)).toBe(true);
    expect(decryptSecret(stored)).toBe(secret);
  });

  it('uses a fresh IV, so the same plaintext never produces the same ciphertext', () => {
    const a = encryptSecret('same-secret');
    const b = encryptSecret('same-secret');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it('refuses tampered ciphertext (GCM authentication tag)', () => {
    const stored = encryptSecret('another-secret');
    const parts = stored.split(':');
    const flipped = `${parts[0]}:${parts[1]}:${parts[2]}:${Buffer.from('tampered').toString('base64url')}`;
    expect(() => decryptSecret(flipped)).toThrow();
    // Wrong version prefix and truncated payloads are rejected outright.
    expect(() => decryptSecret('v2:aaaa:bbbb:cccc')).toThrow(/Malformed/);
    expect(() => decryptSecret('v1:not:a:secret')).toThrow();
  });

  it('compares secrets in constant time and never by length shortcut', () => {
    expect(safeEqual('key-abcdef', 'key-abcdef')).toBe(true);
    expect(safeEqual('key-abcdef', 'key-abcdeg')).toBe(false);
    expect(safeEqual('key-abcdef', 'short')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('generates 12-character mixed SIP passwords (operator-required format)', () => {
    const password = generateSipPassword();
    expect(password).toMatch(/^[A-Za-z0-9!@#$^*?+.\-~]{12}$/);
    expect(/[a-z]/.test(password)).toBe(true);
    expect(/[A-Z]/.test(password)).toBe(true);
    expect(/[0-9]/.test(password)).toBe(true);
    expect(/[!@#$^*?+.\-~]/.test(password)).toBe(true);
    expect(generateSipPassword(16)).toHaveLength(16);
    expect(generateSipPassword()).not.toBe(generateSipPassword());
    // Referral codes deliberately keep their alphanumeric alphabet.
    expect(generateReferralCode(8)).toMatch(/^[A-Z0-9]{8}$/);
    expect(generateNumericCode(6)).toMatch(/^\d{6}$/);
  });

  it('produces a stable HMAC for idempotency keys', () => {
    expect(hmac('payload', 'key')).toBe(hmac('payload', 'key'));
    expect(hmac('payload', 'key')).not.toBe(hmac('payload', 'other'));
    expect(hmac('payload', 'key')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('error taxonomy (spec §36)', () => {
  it('maps codes to HTTP statuses and exposes a user-safe message', () => {
    expect(badInput('nope').httpStatus).toBe(400);
    expect(notFound('User').httpStatus).toBe(404);
    expect(forbidden().httpStatus).toBe(403);
    expect(rateLimited().httpStatus).toBe(429);
    const err = new AppError('PBX_UNAVAILABLE', 'The PBX is unreachable');
    expect(err.httpStatus).toBe(502);
    // The message carries the code (logs) but userMessage stays clean (Telegram).
    expect(err.message).toContain('PBX_UNAVAILABLE');
    expect(err.userMessage).toBe('The PBX is unreachable');
    expect(err.userMessage).not.toContain('PBX_UNAVAILABLE');
  });

  it('serialises without leaking internals and wraps unknown failures', () => {
    expect(new AppError('NOT_FOUND', 'User not found').toJSON()).toEqual({
      code: 'NOT_FOUND',
      message: 'User not found',
      details: undefined,
    });
    const wrapped = toAppError(new Error('ECONNREFUSED 10.0.0.5:3306'));
    expect(wrapped.code).toBe('INTERNAL');
    expect(wrapped.userMessage).not.toContain('10.0.0.5');
    // Already-typed errors pass through untouched.
    const original = badInput('bad');
    expect(toAppError(original)).toBe(original);
  });
});

describe('sliding-window rate limiter (spec §37)', () => {
  it('allows up to the limit inside the window, then blocks with a retry hint', () => {
    const limiter = new RateLimiter(2, 60_000);
    expect(limiter.check('user:1').allowed).toBe(true);
    expect(limiter.check('user:1').remaining).toBe(0);
    const third = limiter.check('user:1');
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    expect(third.retryAfter).toBeGreaterThan(0);
    expect(third.retryAfter).toBeLessThanOrEqual(60);
  });

  it('isolates buckets per key and resets on demand', () => {
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(true); // different user is unaffected
    expect(limiter.check('a').allowed).toBe(false);
    limiter.reset('a');
    expect(limiter.check('a').allowed).toBe(true);
  });

  it('slides the window as time passes', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const limiter = new RateLimiter(1, 60_000);
      expect(limiter.check('k').allowed).toBe(true);
      expect(limiter.check('k').allowed).toBe(false);
      vi.setSystemTime(new Date('2026-01-01T00:01:01.000Z'));
      expect(limiter.check('k').allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CSV import parsing (spec §13)', () => {
  it('accepts an optional header, blank lines and messy separators', () => {
    const { values, malformed } = parseNumberCsv(
      ['phone_number', '+971501234567', '', '00971 50 765 4321', '(971) 50-111-2222', 'not-a-number'].join('\n'),
    );
    expect(values).toEqual(['+971501234567', '00971 50 765 4321', '(971) 50-111-2222']);
    expect(malformed).toBe(1);
  });

  it('tolerates a headerless single-column file', () => {
    expect(parseNumberCsv('+15045043535\n+12025550123').values).toHaveLength(2);
    expect(parseNumberCsv('number\n+15045043535').values).toEqual(['+15045043535']);
  });
});

describe('FreePBX schema drift (real PBX builds differ from the docs)', () => {
  it('reads the offending field and type out of a GraphQL error', () => {
    const errors = [
      { message: 'Cannot query field "callerId" on type "coredevice".', locations: [{ line: 1, column: 308 }] },
      { message: 'Cannot query field "sipdriver" on type "coredevice".' },
      { message: 'Something else entirely' },
    ];
    expect(extractUnsupportedFields(errors)).toEqual([
      { field: 'callerId', typeName: 'coredevice' },
      { field: 'sipdriver', typeName: 'coredevice' },
    ]);
    expect(extractUnsupportedFields([])).toEqual([]);
  });

  it('drops the field from the selection set and leaves arguments alone', () => {
    const query = `query fetchExtension($extensionId: ID) {
      fetchExtension(extensionId: $extensionId) {
        status extensionId
        coreDevice { deviceId dial tech callerId sipdriver }
      }
    }`;
    const { query: rewritten, stripped } = stripFields(query, ['callerId', 'sipdriver']);
    expect(stripped.sort()).toEqual(['callerId', 'sipdriver']);
    expect(rewritten).toContain('coreDevice { deviceId dial tech }');
    expect(rewritten).not.toMatch(/callerId|sipdriver/);
    // Untouched pieces survive.
    expect(rewritten).toContain('fetchExtension(extensionId: $extensionId)');
    expect(rewritten).toContain('status extensionId');
  });

  it('never touches a field used as an argument, and reports nothing when the field is absent', () => {
    const mutation = 'mutation { updateExtension(input: { extensionId: "100", callerId: "X" }) { status } }';
    const { query: same, stripped } = stripFields(mutation, ['callerId']);
    // `callerId:` is an argument here, not a selection: the query is unchanged.
    expect(same).toBe(mutation);
    expect(stripped).toEqual([]);

    const read = 'query { fetchExtension(extensionId: "1") { status } }';
    expect(stripFields(read, ['ringtimer']).query).toBe(read);
  });

  it('removes a parent object whose selection set would become empty (invalid GraphQL)', () => {
    const query = 'query { fetchExtension(extensionId: "1") { status coreDevice { callerId } } }';
    const { query: rewritten } = stripFields(query, ['callerId']);
    expect(rewritten).not.toContain('coreDevice');
    expect(rewritten).toContain('{ status }');
  });
});

/**
 * The wiki is not the deployment. On the PBX this platform was verified against
 * (`freePBX 17`), `addExtensionInput` spells the caller IDs `outboundCid` /
 * `emergencyCid`, types `maxContacts` as a **String**, and answering
 * `umEnable: false` makes every later `updateExtension` return `{status: null}`
 * - so the SIP secret was never applied. These tests pin the behaviour that
 * fixes all three: the mutation input is built from the live schema, and
 * `umEnable` is only sent when a caller explicitly asks for it.
 */
describe('mutation inputs follow the live PBX schema, not the wiki', () => {
  const introspection = {
    mutation: {
      __type: {
        fields: [
          {
            name: 'addExtension',
            args: [{ name: 'input', type: { kind: 'NON_NULL', name: null, ofType: { kind: 'INPUT_OBJECT', name: 'addExtensionInput' } } }],
          },
          {
            name: 'updateExtension',
            args: [{ name: 'input', type: { kind: 'NON_NULL', name: null, ofType: { kind: 'INPUT_OBJECT', name: 'updateExtensionInput' } } }],
          },
        ],
      },
    },
    addExtensionInput: {
      __type: {
        inputFields: [
          { name: 'extensionId', type: { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'ID' } } },
          { name: 'name', type: { kind: 'SCALAR', name: 'String' } },
          { name: 'tech', type: { kind: 'SCALAR', name: 'String' } },
          { name: 'outboundCid', type: { kind: 'SCALAR', name: 'String' } },
          { name: 'emergencyCid', type: { kind: 'SCALAR', name: 'String' } },
          { name: 'email', type: { kind: 'SCALAR', name: 'String' } },
          { name: 'maxContacts', type: { kind: 'SCALAR', name: 'String' } },
          { name: 'vmEnable', type: { kind: 'SCALAR', name: 'Boolean' } },
          { name: 'umEnable', type: { kind: 'SCALAR', name: 'Boolean' } },
          { name: 'umPassword', type: { kind: 'SCALAR', name: 'String' } },
          { name: 'clientMutationId', type: { kind: 'SCALAR', name: 'String' } },
        ],
      },
    },
    updateExtensionInput: {
      __type: {
        inputFields: [
          { name: 'extensionId', type: { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'ID' } } },
          { name: 'name', type: { kind: 'SCALAR', name: 'String' } },
          { name: 'extPassword', type: { kind: 'SCALAR', name: 'String' } },
        ],
      },
    },
  } as const;

  function stubClient(serverPassword: string | null = 'PBX-GENERATED') {
    const calls: Array<{ operation: string; variables: Record<string, unknown>; query: string }> = [];
    const client = new FreePBXGraphQLClient();
    (client as unknown as { execute: unknown }).execute = async (query: string, variables: unknown, operation: string) => {
      if (operation === 'introspection') {
        if (query.includes('__type(name: "Mutation")')) return introspection.mutation;
        if (query.includes('__type(name: "addExtensionInput")')) return introspection.addExtensionInput;
        if (query.includes('__type(name: "updateExtensionInput")')) return introspection.updateExtensionInput;
        return { __type: null };
      }
      calls.push({ operation, variables: (variables ?? {}) as Record<string, unknown>, query });
      if (operation === 'addExtension') return { addExtension: { status: true, message: 'Extension has been created Successfully' } };
      if (operation === 'updateExtension') return { updateExtension: { status: true, message: 'Extension has been updated' } };
      if (operation === 'fetchExtension') {
        return { fetchExtension: { status: true, extensionId: '10000', user: { extPassword: serverPassword ?? undefined } } };
      }
      throw new Error(`unexpected operation ${operation}`);
    };
    return { client, calls };
  }

  it('reads "does not exist" as an empty answer, not a failure (live-build wording)', async () => {
    const client = new FreePBXGraphQLClient();
    const missing = new FreePBXError('FreePBX fetchExtension failed with HTTP 400', 'REJECTED', {
      httpStatus: 400,
      errors: { errors: [{ message: 'Extension does not exists', status: false }] },
    });
    (client as unknown as { execute: unknown }).execute = async () => {
      throw missing;
    };
    await expect(client.getExtension('88888')).resolves.toBeNull();

    // A genuine PBX problem still surfaces.
    (client as unknown as { execute: unknown }).execute = async () => {
      throw new FreePBXError('FreePBX fetchExtension failed with HTTP 500', 'REJECTED', { httpStatus: 500 });
    };
    await expect(client.getExtension('10000')).rejects.toBeInstanceOf(FreePBXError);
  });

  it('coerces values to the scalar the schema declares', () => {
    expect(coerceScalar(2, 'String')).toBe('2');
    expect(coerceScalar('2', 'Int')).toBe(2);
    expect(coerceScalar(true, 'String')).toBe('true');
    expect(coerceScalar('true', 'Boolean')).toBe(true);
    expect(coerceScalar('keep', 'String')).toBe('keep');
    expect(coerceScalar('not-a-number', 'Int')).toBe('not-a-number'); // left for the PBX to judge
    expect(coerceScalar(1.5, 'Float')).toBe(1.5);
  });

  it('never sends umEnable=false (it silently breaks updateExtension on real builds)', async () => {
    const { client, calls } = stubClient();
    await client.createExtension({ extensionId: '10000', name: 'Test', tech: 'pjsip', email: 'x@invalid.local' });

    const add = calls.find((c) => c.operation === 'addExtension');
    expect(add).toBeDefined();
    const input = add?.variables.input as Record<string, unknown>;
    expect('umEnable' in input).toBe(false);
    expect('umPassword' in input).toBe(false);
    // and the password really was applied (our own), because the PBX accepted it
    const update = calls.find((c) => c.operation === 'updateExtension');
    expect(typeof (update?.variables.input as Record<string, unknown>).extPassword).toBe('string');
  });

  it('asks for user-management only when a caller explicitly wants it', async () => {
    const { client, calls } = stubClient();
    await client.createExtension(
      { extensionId: '10000', name: 'Test', tech: 'pjsip', email: 'x@invalid.local', umEnable: true, umPassword: 'um-secret' },
    );
    const input = calls.find((c) => c.operation === 'addExtension')?.variables.input as Record<string, unknown>;
    expect(input.umEnable).toBe(true);
    expect(input.umPassword).toBe('um-secret');
  });

  it('sends the input type and scalar types this PBX actually has', async () => {
    const { client, calls } = stubClient();
    await client.createExtension({
      extensionId: '10000',
      name: 'Test',
      tech: 'pjsip',
      email: 'x@invalid.local',
      outboundCid: '+971500000000',
      maxContacts: 2,
    });

    const add = calls.find((c) => c.operation === 'addExtension');
    // documented camel-case spelling -> the build's own field name
    expect((add?.variables.input as Record<string, unknown>).outboundCid).toBe('+971500000000');
    // Int in the docs, String on this build: sending 2 fails the whole mutation
    expect((add?.variables.input as Record<string, unknown>).maxContacts).toBe('2');
    // variable type comes from the mutation signature, not the wiki's `AddExtensionInput`
    expect(add?.query).toContain('($input: addExtensionInput!)');
    expect(add?.query).not.toContain('AddExtensionInput');
  });

  it('drops input keys this build does not have instead of inventing them', async () => {
    const { client, calls } = stubClient();
    await client.createExtension({
      extensionId: '10000',
      name: 'Test',
      tech: 'pjsip',
      email: 'x@invalid.local',
      ...({ notAField: 'nope' } as Record<string, unknown>),
    });
    const input = calls.find((c) => c.operation === 'addExtension')?.variables.input as Record<string, unknown>;
    expect('notAField' in input).toBe(false);
  });

  it('reports the PBX-generated secret when the PBX overrides the one we asked for', async () => {
    const { client } = stubClient('PBX-GENERATED');
    const created = await client.createExtension(
      { extensionId: '10000', name: 'Test', tech: 'pjsip', email: 'x@invalid.local' },
      { sipPassword: 'our-choice' },
    );
    expect(created.sipPassword).toBe('PBX-GENERATED');
    expect(created.message).toMatch(/PBX-generated/i);
  });

  it('keeps the requested secret when the PBX applied it', async () => {
    const { client } = stubClient('our-choice');
    const created = await client.createExtension(
      { extensionId: '10000', name: 'Test', tech: 'pjsip', email: 'x@invalid.local' },
      { sipPassword: 'our-choice' },
    );
    expect(created.sipPassword).toBe('our-choice');
    expect(created.message).not.toMatch(/PBX-generated/i);
  });
});

describe('audit metadata scrubbing (spec §34 - no secrets in logs)', () => {
  it('redacts password/token/secret fields at any depth', () => {
    const scrubbed = scrubMetadata({
      extension: 10000,
      password: 'hunter2',
      nested: { sip_password: 'hunter2', apiToken: 'abc', keep: 'visible' },
      list: [{ token: 'xyz', note: 'ok' }],
    }) as Record<string, unknown>;

    expect(scrubbed.extension).toBe(10000);
    expect(scrubbed.password).toBe('[REDACTED]');
    const nested = scrubbed.nested as Record<string, unknown>;
    expect(nested.sip_password).toBe('[REDACTED]');
    expect(nested.apiToken).toBe('[REDACTED]');
    expect(nested.keep).toBe('visible');
    const list = scrubbed.list as Array<Record<string, unknown>>;
    expect(list[0]?.token).toBe('[REDACTED]');
    expect(list[0]?.note).toBe('ok');
  });
});

describe('FreePBX DID sanitation (digits only, never "+")', () => {
  it('strips every non-digit from DID patterns', () => {
    expect(sanitizeDid('+12025550026')).toBe('12025550026');
    expect(sanitizeDid('+971 50 123 45011')).toBe('9715012345011');
    expect(sanitizeDid('(202) 555-0026')).toBe('2025550026');
    expect(sanitizeDid('12025550026')).toBe('12025550026');
  });

  it('applyInboundRoute writes digits-only to the PBX and to the DB', async () => {
    const [numberId] = await addNumbersToInventory({ count: 1 });
    const pbx = mockPbx();
    const seenRoutes = pbx.state.routes as unknown as Map<string, Record<string, unknown>>;
    await applyInboundRoute({
      numberId: numberId!,
      assignmentId: null,
      didPattern: '+971 50 123 4567',
      extension: '10123',
      description: '+test +desc legit',
    } as never);
    const route = [...seenRoutes.values()][0];
    expect(route?.extension).toBe('971501234567');            // PBX receives digits only
    expect(String(route?.description ?? '')).not.toMatch(/\+/);
    const row = await getRouteForNumber(numberId!);
    expect(row?.did_match_pattern).toBe('971501234567');      // DB row keeps digits only
  });
});

describe('shared notification sender (worker + bot must carry buttons)', () => {
  it('attaches the inline keyboard to api.sendMessage (regression: worker dropped buttons)', async () => {
    const calls: Array<{ opts?: Record<string, unknown> }> = [];
    const sender = createTelegramSender(async (_chat: number | string, _text: string, opts?: Record<string, unknown>) => {
      calls.push({ opts });
    })!;
    await sender(42, 'Hello <b>admin</b>', {
      buttons: [[{ text: '✅ Approve', callbackData: 'a:uap:UUID' }, { text: '❌ Reject', callbackData: 'a:urej:UUID' }]],
    } as never);
    const markup = (calls[0]?.opts as { reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } })?.reply_markup;
    expect(markup?.inline_keyboard).toEqual([[
      { text: '✅ Approve', callback_data: 'a:uap:UUID' },
      { text: '❌ Reject', callback_data: 'a:urej:UUID' },
    ]]);
    expect((calls[0]?.opts as Record<string, unknown>)?.parse_mode).toBe('HTML');
  });

  it('sends plain markup-free messages when a notification has no buttons', async () => {
    const calls: Array<{ opts?: Record<string, unknown> }> = [];
    const sender = createTelegramSender(async (_c: number | string, _t: string, opts?: Record<string, unknown>) => { calls.push({ opts }); })!;
    await sender(42, 'plain', undefined);
    expect(Object.prototype.hasOwnProperty.call(calls[0]?.opts ?? {}, 'reply_markup')).toBe(false);
  });
});

describe('admin approval-request notification buttons', () => {
  it('attaches ✅ Approve / ❌ Reject under a user-approval request', () => {
    const buttons = notificationButtons({
      kind: 'ADMIN_NEW_USER',
      payload: { userId: '11111111-2222-3333-4444-555555555555', telegramId: 42 },
    } as never);
    expect(buttons).toEqual([[
      { text: '✅ Approve', callbackData: 'a:uap:11111111-2222-3333-4444-555555555555' },
      { text: '❌ Reject', callbackData: 'a:urej:11111111-2222-3333-4444-555555555555' },
    ]]);
  });

  it('stays buttonless for every other kind and for a malformed payload', () => {
    expect(notificationButtons({ kind: 'NUMBER_RELEASED', payload: {} } as never)).toBeUndefined();
    expect(notificationButtons({ kind: 'ADMIN_NEW_USER', payload: { userId: 'not-a-uuid' } } as never)).toBeUndefined();
  });
});

describe('transient postgres connection errors (cloud blip hardening)', () => {
  it('classifies transport failures as retryable and SQL errors as not', () => {
    expect(isTransientPgConnectionError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientPgConnectionError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isTransientPgConnectionError(new Error('server closed the connection'))).toBe(true);
    expect(isTransientPgConnectionError(new Error('duplicate key value violates unique constraint'))).toBe(false);
    expect(isTransientPgConnectionError(Object.assign(new Error('sorry, too many clients'), { code: '53300' }))).toBe(false);
    expect(isTransientPgConnectionError(Object.assign(new Error('deadlock detected'), { code: '40P01' }))).toBe(false);
  });
});

describe('notification wake scheduler (LISTEN/NOTIFY fast path)', () => {
  it('collapses a burst of pokes into a single sweep', async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      const scheduler = createWakeScheduler(async () => {
        runs += 1;
      }, 250);
      scheduler.poke();
      scheduler.poke();
      scheduler.poke();
      await vi.advanceTimersByTimeAsync(300);
      expect(runs).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runs).toBe(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs exactly one trailing sweep for pokes that arrive mid-run (never overlapping)', async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      let resolveRun: (() => void) | null = null;
      const scheduler = createWakeScheduler(async () => {
        runs += 1;
        await new Promise<void>((resolve) => {
          resolveRun = resolve;
        });
      }, 250);
      scheduler.poke();
      await vi.advanceTimersByTimeAsync(300);
      expect(runs).toBe(1);
      // Wake signals while the first sweep is still delivering.
      scheduler.poke();
      scheduler.poke();
      resolveRun!();
      await vi.advanceTimersByTimeAsync(300);
      expect(runs).toBe(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runs).toBe(2);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() cancels a queued sweep and ignores later pokes', async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      const scheduler = createWakeScheduler(async () => {
        runs += 1;
      }, 250);
      scheduler.poke();
      scheduler.stop();
      scheduler.poke();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runs).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failing sweep never wedges the scheduler', async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      const scheduler = createWakeScheduler(async () => {
        runs += 1;
        if (runs === 1) throw new Error('simulated outage');
      }, 250);
      scheduler.poke();
      await vi.advanceTimersByTimeAsync(300);
      expect(runs).toBe(1);
      scheduler.poke();
      await vi.advanceTimersByTimeAsync(300);
      expect(runs).toBe(2);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AMI client connection lifecycle (blackhole firewall hardening)', () => {
  async function withAmiServer(serve: (socket: import('node:net').Socket) => void): Promise<{ port: number; connections: () => number; close: () => Promise<void> }> {
    const net = await import('node:net');
    let connections = 0;
    const sockets = new Set<import('node:net').Socket>();
    const server = net.createServer((socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      serve(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return {
      port,
      connections: () => connections,
      close: async () => {
        // server.close() only returns once every connection ended; destroy
        // them explicitly (no Server#closeAllConnections on this Node).
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  it('marks connected only after a successful Login handshake', async () => {
    const { AmiClient } = await import('../src/freepbx/ami.js');
    const banner = 'Asterisk Call Manager/6.0.0\n';
    const srv = await withAmiServer((socket) => {
      socket.write(banner + '\r\n');
      let buf = '';
      socket.on('data', (d) => {
        buf += d.toString();
        let i = buf.search(/\r?\n\r?\n/);
        while (i !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const id = /ActionID: (\S+)/.exec(block)?.[1] ?? 'x';
          const action = /Action: (\S+)/.exec(block)?.[1] ?? '';
          if (action === 'Login') socket.write(`Response: Success\r\nActionID: ${id}\r\nMessage: Authentication accepted\r\n\r\n`);
          else if (action === 'Ping') socket.write(`Response: Success\r\nActionID: ${id}\r\nPing: Pong\r\n\r\n`);
          i = buf.search(/\r?\n\r?\n/);
        }
      });
    });
    const client = new AmiClient({ enabled: true, host: '127.0.0.1', port: srv.port, user: 'u', secret: 's', tls: false, tlsVerify: false, watchdogMs: 500, pingIntervalMs: 60 });
    // Synchronously after connect begins the client must NOT claim connected -
    // the TCP handshake alone proves nothing (SYN-proxied firewalls).
    expect(client.status().connected).toBe(false);
    await client.start();
    expect(client.status().connected).toBe(true);
    await client.stop();
    await srv.close();
  });

  it('detects a silent (blackhole) socket instead of reporting connected forever', async () => {
    const { AmiClient } = await import('../src/freepbx/ami.js');
    const srv = await withAmiServer(() => {
      // Accept and say nothing: exactly what a SYN-proxying firewall does.
    });
    const client = new AmiClient({ enabled: true, host: '127.0.0.1', port: srv.port, user: 'u', secret: 's', tls: false, tlsVerify: false, watchdogMs: 300, pingIntervalMs: 10_000 });
    await client.start().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 700));
    const status = client.status();
    expect(status.connected).toBe(false);
    expect(status.detail ?? '').toMatch(/never answered|banner|silently dropping/i);
    await client.stop();
    await srv.close();
  });

  it('reconnects after the server drops the session post-login', async () => {
    const { AmiClient } = await import('../src/freepbx/ami.js');
    const logins: number[] = [];
    const srv = await withAmiServer((socket) => {
      let buf = '';
      socket.on('data', (d) => {
        buf += d.toString();
        let i = buf.search(/\r?\n\r?\n/);
        while (i !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const id = /ActionID: (\S+)/.exec(block)?.[1] ?? 'x';
          const action = /Action: (\S+)/.exec(block)?.[1] ?? '';
          if (action === 'Login') { logins.push(1); socket.write(`Response: Success\r\nActionID: ${id}\r\n\r\n`); }
          else if (action === 'Ping') socket.write(`Response: Success\r\nActionID: ${id}\r\nPing: Pong\r\n\r\n`);
          i = buf.search(/\r?\n\r?\n/);
        }
      });
      // Drop every connection 150ms after it arrives.
      setTimeout(() => socket.destroy(), 150);
    });
    const client = new AmiClient({ enabled: true, host: '127.0.0.1', port: srv.port, user: 'u', secret: 's', tls: false, tlsVerify: false, watchdogMs: 1_000, pingIntervalMs: 10_000 });
    await client.start().catch(() => undefined);
    // Network retries back off exponentially (5s -> 10s -> 20s -> ~5min cap):
    // the second login lands around 10s in, and no third login appears within
    // the following 4s (a flat 5s retry would produce one).
    await new Promise((r) => setTimeout(r, 10_800));
    expect(logins.length).toBeGreaterThanOrEqual(2);
    const afterTwo = logins.length;
    await new Promise((r) => setTimeout(r, 4_000));
    expect(logins.length).toBe(afterTwo);
    await client.stop();
    const seenConnections = srv.connections();
    await new Promise((r) => setTimeout(r, 200));
    expect(srv.connections()).toBe(seenConnections); // stop() cancels the retry
    await srv.close();
  }, 20_000);
});
