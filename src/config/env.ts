import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  LOG_PRETTY: boolish.default(false),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(8080),
  API_KEY: z.string().min(8, 'API_KEY must be at least 8 chars'),
  API_IP_ALLOWLIST: z.string().default(''),
  API_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(120),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Public SIP endpoint shown to users (defaults to the FreePBX host:5060).
  SIP_HOST: z.string().optional(),
  SIP_PORT: z.coerce.number().int().default(5060),
  PGPOOL_MAX: z.coerce.number().int().positive().default(15),
  PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_SUPER_ADMIN_IDS: z.string().default(''),
  TELEGRAM_REQUIRED_CHANNEL: z.string().default(''),
  // MTProto user-app credentials (userbot features: membership sweeps etc.)
  TELEGRAM_API_ID: z.coerce.number().int().default(0),
  TELEGRAM_API_HASH: z.string().default(''),
  SUPPORT_USERNAME: z.string().default(''),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(''),
  TELEGRAM_WEBHOOK_URL: z.string().default(''),

  SECRETS_KEK_BASE64: z.string().default(''),
  SIGNING_KEY: z.string().min(8, 'SIGNING_KEY must be at least 8 chars'),

  FREEPBX_BASE_URL: z.string().default(''),
  FREEPBX_CLIENT_ID: z.string().default(''),
  FREEPBX_CLIENT_SECRET: z.string().default(''),
  FREEPBX_TOKEN_URL: z.string().default(''),
  FREEPBX_GRAPHQL_URL: z.string().default(''),
  FREEPBX_SCOPE: z.string().default(''),
  FREEPBX_CA_FILE: z.string().default(''),
  FREEPBX_TLS_VERIFY: boolish.default(true),
  FREEPBX_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  FREEPBX_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  FREEPBX_DEFAULT_OUTBOUND_CID: z.string().default(''),
  FREEPBX_MODE: z.enum(['graphql', 'mock']).default('mock'),

  AMI_ENABLED: boolish.default(false),
  AMI_HOST: z.string().default('127.0.0.1'),
  AMI_PORT: z.coerce.number().int().positive().default(5038),
  AMI_USER: z.string().default(''),
  AMI_SECRET: z.string().default(''),
  AMI_TLS: boolish.default(false),
  AMI_TLS_VERIFY: boolish.default(true),
  AMI_INBOUND_CHANNEL_PREFIX: z.string().default('PJSIP/'),

  DID_NORMALIZE_STRIP_PLUS: boolish.default(true),
  DID_PREFIX: z.string().default(''),
  FREEPBX_ROUTE_DESTINATION_TEMPLATE: z.string().default('from-did-direct,{ext},1'),
  EXTENSION_RANGE_START: z.coerce.number().int().positive().default(10_000),
  EXTENSION_RANGE_END: z.coerce.number().int().positive().default(19_999),

  DEFAULT_PLAN_CODE: z.string().default('free'),
  MAX_NUMBER_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(5),
  MAX_START_PER_MINUTE: z.coerce.number().int().positive().default(10),
  DEFAULT_USER_EXPIRES_DAYS: z.coerce.number().int().positive().default(30),
  DEFAULT_NUMBER_EXPIRES_DAYS: z.coerce.number().int().positive().default(30),

  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  EXPIRY_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(900_000),
  EXPIRY_NOTICE_DAYS: z.string().default('3,1'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`\nInvalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.\n`);
  process.exit(1);
}

const e = parsed.data;

function csv(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const isProd = e.NODE_ENV === 'production';
const isTest = e.NODE_ENV === 'test';

/**
 * In production the PBX integration and the Telegram token must be configured.
 * We fail fast instead of silently running against a mock PBX.
 */
if (isProd) {
  const problems: string[] = [];
  if (!e.TELEGRAM_BOT_TOKEN) problems.push('TELEGRAM_BOT_TOKEN is required in production');
  if (!e.SECRETS_KEK_BASE64) problems.push('SECRETS_KEK_BASE64 is required in production (encrypts SIP secrets at rest)');
  if (e.FREEPBX_MODE === 'graphql') {
    for (const k of ['FREEPBX_BASE_URL', 'FREEPBX_CLIENT_ID', 'FREEPBX_CLIENT_SECRET', 'FREEPBX_GRAPHQL_URL', 'FREEPBX_TOKEN_URL'] as const) {
      if (!e[k]) problems.push(`${k} is required when FREEPBX_MODE=graphql`);
    }
  }
  if (e.API_KEY.startsWith('change-me')) problems.push('API_KEY is still the placeholder value');
  if (e.SIGNING_KEY.startsWith('change-me')) problems.push('SIGNING_KEY is still the placeholder value');
  if (problems.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`\nRefusing to start in production:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.exit(1);
  }
}

export const env = {
  ...e,
  isProd,
  isTest,
  isDev: e.NODE_ENV === 'development',
  superAdminIds: csv(e.TELEGRAM_SUPER_ADMIN_IDS).map((s) => s.trim()),
  apiIpAllowlist: csv(e.API_IP_ALLOWLIST),
  expiryNoticeDays: csv(e.EXPIRY_NOTICE_DAYS).map(Number).filter((n) => Number.isFinite(n)),
  freepbx: {
    baseUrl: e.FREEPBX_BASE_URL.replace(/\/+$/, ''),
    clientId: e.FREEPBX_CLIENT_ID,
    clientSecret: e.FREEPBX_CLIENT_SECRET,
    tokenUrl: e.FREEPBX_TOKEN_URL || `${e.FREEPBX_BASE_URL.replace(/\/+$/, '')}/admin/api/api/token`,
    graphqlUrl: e.FREEPBX_GRAPHQL_URL || `${e.FREEPBX_BASE_URL.replace(/\/+$/, '')}/admin/api/api/gql`,
    scope: e.FREEPBX_SCOPE,
    caFile: e.FREEPBX_CA_FILE,
    tlsVerify: e.FREEPBX_TLS_VERIFY,
    timeoutMs: e.FREEPBX_TIMEOUT_MS,
    maxRetries: e.FREEPBX_MAX_RETRIES,
    mode: e.FREEPBX_MODE,
    defaultOutboundCid: e.FREEPBX_DEFAULT_OUTBOUND_CID,
    routeDestinationTemplate: e.FREEPBX_ROUTE_DESTINATION_TEMPLATE,
    extensionRange: { start: e.EXTENSION_RANGE_START, end: e.EXTENSION_RANGE_END },
  },
  userbot: {
    apiId: e.TELEGRAM_API_ID,
    apiHash: e.TELEGRAM_API_HASH,
  },
  ami: {
    enabled: e.AMI_ENABLED,
    host: e.AMI_HOST,
    port: e.AMI_PORT,
    user: e.AMI_USER,
    secret: e.AMI_SECRET,
    tls: e.AMI_TLS,
    tlsVerify: e.AMI_TLS_VERIFY,
    inboundChannelPrefix: e.AMI_INBOUND_CHANNEL_PREFIX,
  },
} as const;

export type Env = typeof env;
