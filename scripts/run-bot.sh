#!/usr/bin/env bash
# Crash-proof supervisor: tsx watch only restarts on FILE changes, never on a
# child crash (observed live: FATAL at 10:18 -> shutdown complete -> dead bot).
# This loop respawns on ANY exit. Plain tsx (no watch) because this sandbox's
# deploys restart the whole process tree anyway.
cd "$(dirname "$0")/.."
while true; do
  echo "[supervisor] bot starting $(date -u +%FT%TZ)"
  npx tsx src/index.ts
  code=$?
  echo "[supervisor] bot exited with $code; respawning in 3s"
  sleep 3
done
