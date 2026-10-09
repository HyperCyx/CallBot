import * as kb from '../src/bot/keyboards.js';
import { InlineKeyboard } from 'grammy';
const builders: [string, any][] = [
  ['mainMenu', kb.mainMenuKeyboard(false)],
  ['wallet', kb.walletKeyboard(true)],
  ['insufficient', kb.insufficientFundsKeyboard()],
  ['depositMethod', kb.depositMethodKeyboard([{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', icon: '💠', name: 'USDT' }])],
  ['payMethods', kb.paymentMethodsKeyboard([{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', icon: '💠', name: 'USDT', status: 'ACTIVE' }])],
  ['payMethodDetail', kb.paymentMethodDetailKeyboard({ id: 'x', status: 'ACTIVE' })],
  ['depositsQueue', kb.depositsQueueKeyboard([{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', display_name: 'u', username: null, telegram_id: 1, amount_cents: 500 }])],
  ['backToMenu', kb.backToMenuKeyboard(false)],
  ['withBack', kb.withBack(new InlineKeyboard().text('x', 'y'))],
];
let bad = 0;
for (const [name, k] of builders) {
  let backs = 0;
  for (const row of (k as any).inline_keyboard) for (const btn of row) if (btn.callback_data === 'nav:back') backs++;
  if (backs !== 1) { bad++; console.log(name, '->', backs, 'back buttons!'); }
}
console.log(bad === 0 ? 'ALL KEYBOARDS: exactly one Back row OK' : bad + ' violations');
