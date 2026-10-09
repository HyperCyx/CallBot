-- 018: forced channel/group membership gate (operator order 2026-10-08).
-- Seeds the operator's two chats as DB-driven required chats and turns the
-- gate ON. The bot must be an admin of both chats for getChatMember to work;
-- if it is not, the gate fails open and the admins get an alert.

INSERT INTO admin_settings (key, value, value_type, category, label, description, is_editable)
VALUES (
  'bot.required_chats',
  '[
    {"chatId":"-1002066974831","title":"AI Unbox — Channel","url":"https://t.me/ai_unbox","kind":"channel"},
    {"chatId":"-1002205812723","title":"AI Unbox — Group","url":"https://t.me/+1LMI2ob9aHI3ZWQ9","kind":"group"}
  ]'::jsonb,
  'json',
  'bot',
  'Required chats to join',
  'Users must be members of every listed chat before they can register or continue. Checked live via Telegram (chatId), users see the URL of each chat they are missing.',
  true
)
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      label = EXCLUDED.label,
      description = EXCLUDED.description,
      is_editable = EXCLUDED.is_editable,
      updated_at = now();

UPDATE admin_settings
   SET value = 'true'::jsonb, updated_at = now()
 WHERE key = 'bot.require_channel_membership';
