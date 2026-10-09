#!/usr/bin/env bash
# backup-sync.sh — one iteration of the hybrid backup strategy (operator decision 2026-10-08):
#   1. Full dump of the LOCAL primary DB (postgres@127.0.0.1/sipbot_live) -> /home/user/sipbot/backups/
#   2. Rotate local dump files (keep the newest 24)
#   3. Push the dump to Aiven (replica/backup target) when AIVEN_DATABASE_URL has a real password.
#      The Aiven copy is rebuilt every push (clean-restore, extensions excluded — they already
#      exist on Aiven and avnadmin cannot DROP them). Nothing else writes to Aiven any more.
set -uo pipefail
cd /home/user/sipbot
set -a; source .env 2>/dev/null; set +a

LOCAL="postgres://sipbot:sipbot@127.0.0.1:5432/sipbot_live"
TS="$(date -u +%Y%m%d-%H%M%S)"
OUT="backups/sipbot-${TS}.dump"
LOG="logs/backup.log"
mkdir -p backups logs

if ! /usr/lib/postgresql/17/bin/pg_dump "$LOCAL" -Fc -f "$OUT" 2>>"$LOG"; then
  echo "[$(date -u +%FT%TZ)] LOCAL DUMP FAILED" >> "$LOG"
  exit 1
fi
ls -1t backups/sipbot-*.dump 2>/dev/null | tail -n +25 | xargs -r rm -f

if [[ -n "${AIVEN_DATABASE_URL:-}" && "${AIVEN_DATABASE_URL}" != *CHANGE_ME* ]]; then
  TOC="/tmp/aiven-toc.$$"
  /usr/lib/postgresql/17/bin/pg_restore -l "$OUT" | grep -vE " EXTENSION |COMMENT - EXTENSION" > "$TOC"
  if /usr/lib/postgresql/17/bin/pg_restore -d "$AIVEN_DATABASE_URL" -L "$TOC" --no-owner --no-privileges --clean --if-exists "$OUT" >>"$LOG" 2>&1; then
    echo "[$(date -u +%FT%TZ)] pushed ${OUT} -> Aiven OK" >> "$LOG"
  else
    echo "[$(date -u +%FT%TZ)] AIVEN PUSH FAILED (kept ${OUT} for retry)" >> "$LOG"
  fi
  rm -f "$TOC"
else
  echo "[$(date -u +%FT%TZ)] Aiven password missing (AIVEN_DATABASE_URL is CHANGE_ME) — local dump kept: ${OUT}" >> "$LOG"
fi
