#!/usr/bin/env bash
# run-backup-loop.sh — supervisor: run backup-sync.sh every 5 minutes, forever,
# respawning even after failures (same crash-proof pattern as run-bot.sh).
cd "$(dirname "$0")/.."
until false; do
  bash scripts/backup-sync.sh
  sleep 300
done
