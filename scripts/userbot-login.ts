/**
 * userbot-login.ts — one-time MTProto login (operator action, 2026-10-08).
 *
 * Mints the user-app session that powers the membership sweep. Designed for
 * non-interactive operation (the operator drives it via chat):
 *
 *   npx tsx scripts/userbot-login.ts send +34XXXXXXXXX
 *       -> Telegram sends an SMS/app code to that phone; state saved in DB.
 *   npx tsx scripts/userbot-login.ts confirm 12345
 *       -> finishes login; session stored in admin_settings['userbot.session'].
 *       -> if the account has 2FA: npx tsx scripts/userbot-login.ts password <2fa-password>
 *
 * The operating account just needs to be a MEMBER of the required chats
 * (admin of the channel to enumerate its members; plain member suffices for
 * the group). Membership is entirely independent of the bot being admin.
 */
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import readline from 'node:readline';
import { env } from '../src/config/env.js';
import { query } from '../src/db/pool.js';
import { closePool } from '../src/db/pool.js';

const STATE_KEY = 'userbot.login_state';
const SESSION_KEY = 'userbot.session';

async function saveSetting(key: string, value: unknown, editable = false): Promise<void> {
  await query(
    `INSERT INTO admin_settings (key, value, value_type, category, label, description, is_editable)
     VALUES ($1, $2::jsonb, 'json', 'bot', $3, $4, $5)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [
      key,
      JSON.stringify(value),
      key === SESSION_KEY ? 'Userbot MTProto session' : 'Userbot login state',
      'Managed by scripts/userbot-login.ts - see docs/05-configuration.md',
      editable,
    ],
  );
}

async function readState(): Promise<{ phoneNumber: string; phoneCodeHash: string } | null> {
  const res = await query<{ value: { phoneNumber: string; phoneCodeHash: string } }>(
    'SELECT value FROM admin_settings WHERE key = $1',
    [STATE_KEY],
  );
  return res.rows[0]?.value ?? null;
}

function makeClient(session = ''): TelegramClient {
  if (!env.userbot.apiId || !env.userbot.apiHash) {
    console.error('TELEGRAM_API_ID / TELEGRAM_API_HASH missing in .env');
    process.exit(1);
  }
  return new TelegramClient(new StringSession(session), env.userbot.apiId, env.userbot.apiHash, {
    connectionRetries: 3,
    retryDelay: 2000,
    autoReconnect: false,
  });
}

async function main(): Promise<void> {
  const [cmd, arg1] = process.argv.slice(2);

  if (cmd === 'send') {
    const phone = arg1;
    if (!phone || !/^\+\d{8,15}$/.test(phone)) {
      console.error('Usage: npx tsx scripts/userbot-login.ts send +E164PHONE');
      process.exit(1);
    }
    const client = makeClient();
    await client.connect();
    const { Api } = await import('telegram/tl/index.js');
    const result = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: phone,
        apiId: env.userbot.apiId,
        apiHash: env.userbot.apiHash,
        settings: new Api.CodeSettings({}),
      }),
    );
    if (!(result instanceof Api.auth.SentCode)) {
      console.error('Unexpected response from Telegram:', result.className);
      process.exit(1);
    }
    await saveSetting(STATE_KEY, { phoneNumber: phone, phoneCodeHash: result.phoneCodeHash });
    await client.disconnect();
    console.log(`✅ Code sent to ${phone} (via ${result.type.className}).`);
    console.log('Next: npx tsx scripts/userbot-login.ts confirm <CODE>   (digits only, no dashes)');
  } else if (cmd === 'confirm') {
    const code = arg1?.replace(/\D/g, '');
    const state = await readState();
    if (!state) { console.error('No pending login. Run: send <phone> first.'); process.exit(1); }
    if (!code) { console.error('Usage: npx tsx scripts/userbot-login.ts confirm <CODE>'); process.exit(1); }
    const client = makeClient();
    await client.connect();
    try {
      await client.start({
        phoneNumber: async () => state.phoneNumber,
        phoneCode: async () => code,
        password: async () => {
          throw new Error('PASSWORD_REQUIRED');
        },
        onError: (err: Error) => console.error('login error:', err.message),
      });
    } catch (err) {
      await client.disconnect();
      if ((err as Error).message.includes('PASSWORD_REQUIRED') || (err as Error).message.includes('password')) {
        console.log('🔐 This account has two-factor authentication.');
        console.log('Next: npx tsx scripts/userbot-login.ts password <YOUR-2FA-PASSWORD> <CODE>');
        process.exit(0);
      }
      throw err;
    }
    const session = (client.session as StringSession).save();
    await saveSetting(SESSION_KEY, session);
    await client.disconnect();
    console.log('✅ Login complete - session saved to admin_settings[userbot.session].');
    console.log('The membership sweep will use it on its next run (hourly).');
  } else if (cmd === 'password') {
    const [pw, codeArg] = process.argv.slice(3);
    const code = codeArg?.replace(/\D/g, '');
    const state = await readState();
    if (!state) { console.error('No pending login. Run: send <phone> first.'); process.exit(1); }
    if (!pw || !code) { console.error('Usage: npx tsx scripts/userbot-login.ts password <2FA-PASSWORD> <CODE>'); process.exit(1); }
    const client = makeClient();
    await client.connect();
    await client.start({
      phoneNumber: async () => state.phoneNumber,
      phoneCode: async () => code,
      password: async () => pw,
      onError: (err: Error) => console.error('login error:', err.message),
    });
    const session = (client.session as StringSession).save();
    await saveSetting(SESSION_KEY, session);
    await client.disconnect();
    console.log('✅ Login complete (2FA) - session saved to admin_settings[userbot.session].');
  } else {
    console.log(`userbot login - one-time MTProto session setup
  npx tsx scripts/userbot-login.ts send +34XXXXXXXXX      send login code to that phone
  npx tsx scripts/userbot-login.ts confirm 12345          finish login with the SMS/app code
  npx tsx scripts/userbot-login.ts password <2FA> <CODE>  finish login when 2FA is enabled
Session is stored in admin_settings['userbot.session'] (DB), never in .env.`);
  }
  await closePool();
}

main().catch((err) => {
  console.error('FAILED:', (err as Error).message);
  process.exitCode = 1;
});
