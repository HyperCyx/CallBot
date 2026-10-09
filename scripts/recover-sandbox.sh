#!/usr/bin/env bash
# recover-sandbox.sh — ONE command after a sandbox recycle.
#
# What recycles wipe: processes, apt packages (PostgreSQL)  —  /home/user keeps
# its files EXCEPT the postgres-owned datadir (the snapshotter cannot read a
# 700 root-owned dir, proven 2026-10-08). Durability strategy: the backup loop
# dumps every 5 minutes into /home/user/sipbot/backups/ (those DO persist), so
# recovery = reinstall PG, start a fresh cluster AS THE SANDBOX USER (no sudo
# chown needed), auto-restore the newest dump. Max data loss: ~5 minutes.
#
# Run:  bash scripts/recover-sandbox.sh
set -uo pipefail
cd "$(dirname "$0")/.."
PG_BIN=/usr/lib/postgresql/17/bin
PGDATA=/home/user/pgdata

echo "== 1. PostgreSQL 17 packages =="
if ! dpkg -l 2>/dev/null | grep -q postgresql-17; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq postgresql-17 postgresql-contrib-17
fi

echo "== 2. Cluster =="
[ -d "$PGDATA" ] || mkdir -p "$PGDATA"
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  rm -rf "$PGDATA"; mkdir -p "$PGDATA"; chmod 700 "$PGDATA"
  echo "   fresh initdb (previous datadir did not survive the snapshot)"
  $PG_BIN/initdb -D "$PGDATA" -U sipbot -E UTF8 --locale=C >/dev/null
fi
chmod 700 "$PGDATA" 2>/dev/null  # snapshots restore it as 755; PostgreSQL refuses to start
# Snapshots also strip empty dirs and sometimes whole data subtrees (torn
# syncs, 2026-10-09). Try a start; if PG stays down, the tree is unusable and
# we re-init from scratch - the dumps in backups/ are the real persistence.
if ! pg_isready -h 127.0.0.1 -q 2>/dev/null; then
  $PG_BIN/pg_ctl start -D "$PGDATA" -l "$PGDATA/server.log" \
    -o "-c listen_addresses=127.0.0.1 -p 5432 -c unix_socket_directories=/tmp" -w >/dev/null 2>&1
  if ! pg_isready -h 127.0.0.1 -q 2>/dev/null; then
    echo "   existing datadir is broken (torn snapshot) -> re-init, restore from newest dump"
    rm -rf "$PGDATA"; mkdir -p "$PGDATA"; chmod 700 "$PGDATA"
    $PG_BIN/initdb -D "$PGDATA" -U sipbot -E UTF8 --locale=C >/dev/null
    $PG_BIN/pg_ctl start -D "$PGDATA" -l "$PGDATA/server.log" \
      -o "-c listen_addresses=127.0.0.1 -p 5432 -c unix_socket_directories=/tmp" -w >/dev/null
  fi
fi
psql -h 127.0.0.1 -U sipbot -d postgres -tc \
  "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sipbot') THEN CREATE USER sipbot SUPERUSER PASSWORD 'sipbot'; END IF; END \$\$;" >/dev/null
for db in sipbot_live sipbot_test; do
  psql -h 127.0.0.1 -U sipbot -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 \
    || psql -h 127.0.0.1 -U sipbot -d postgres -c "CREATE DATABASE $db OWNER sipbot;" >/dev/null
done
psql postgres://sipbot:sipbot@127.0.0.1:5432/sipbot_live -qc \
  "CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext;" >/dev/null 2>&1

TABLES=$(psql postgres://sipbot:sipbot@127.0.0.1:5432/sipbot_live -Atqc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null)
if [ -z "${TABLES:-}" ] || [ "$TABLES" -lt 5 ]; then
  # name-sort, NOT mtime-sort: sandbox snapshots reset file mtimes.
  LATEST=$(ls backups/sipbot-*.dump 2>/dev/null | sort | tail -1)
  if [ -n "$LATEST" ]; then
    echo "   live DB is fresh/empty -> restoring $LATEST"
    $PG_BIN/pg_restore -d postgres://sipbot:sipbot@127.0.0.1:5432/sipbot_live --no-owner "$LATEST" || true
  else
    echo "   WARNING: no dump found in backups/ - live DB starts EMPTY"
  fi
fi
echo "   live DB ready: $(psql postgres://sipbot:sipbot@127.0.0.1:5432/sipbot_live -Atqc "SELECT count(*) FROM users" 2>/dev/null) users"

echo "== 3. Node deps =="
[ -d node_modules ] || npm install
[ -d node_modules/telegram ] || npm install  # GramJS was added after the last recycle

echo "== 4. Restart supervisors (Arena start_process) =="
echo "   bot:    bash scripts/run-bot.sh"
echo "   worker: bash scripts/run-worker.sh"
echo "   backup: bash scripts/run-backup-loop.sh"
echo "== done =="
