#!/usr/bin/env bash
# soak.sh [minutes] — live-fleet soak. Samples every 60s:
#   health endpoint (status, db latency, ami), bot/worker PIDs alive,
#   NEW fatals/ECONNRESET/AMI-drops in process logs since soak start (never cumulative),
#   supervisor respawn count diff. Summary printed at end.
MINUTES="${1:-15}"
cd /home/user/sipbot
mkdir -p logs
STAMP="$(date -u +%Y%m%d-%H%M%S)"
SOAKLOG="logs/soak-${STAMP}.log"
BLOG="logs/live-bot.log"; WLOG="logs/live-worker.log"

base_err() { { grep -ciE "fatal|unhandled|ECONNRESET|ETIMEDOUT|AMI connection closed" "$1" 2>/dev/null || echo 0; }; }
BASE_BOT_ERR=$(base_err "$BLOG"); BASE_W_ERR=$(base_err "$WLOG")
base_respawn() { { grep -c "Respawning" "$1" 2>/dev/null || echo 0; }; }
BASE_B_RS=$(base_respawn "$BLOG"); BASE_W_RS=$(base_respawn "$WLOG")

echo "=== SOAK START $(date -u +%FT%TZ) for ${MINUTES}m | baseline errors bot=$BASE_BOT_ERR worker=$BASE_W_ERR respawns b=$BASE_B_RS w=$BASE_W_RS ===" | tee -a "$SOAKLOG"

ok=0; degraded=0; unreachable=0; maxdb=0; bot_died=0; worker_died=0
for i in $(seq 1 "$MINUTES"); do
  H="$(curl -s -m 12 http://127.0.0.1:8080/health 2>/dev/null)"
  if [ -z "$H" ]; then
    status="UNREACHABLE"; dbl="-"; ami="-"; unreachable=$((unreachable+1))
  else
    status=$(echo "$H" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['status'],d['database']['latencyMs'],d['ami'].get('available'),sep='|')" 2>/dev/null || echo "PARSE_ERR|-|-")
    st=$(echo "$status" | cut -d'|' -f1); dbl=$(echo "$status" | cut -d'|' -f2); ami=$(echo "$status" | cut -d'|' -f3); status=$st
    [ "$status" = "ok" ] && ok=$((ok+1)) || degraded=$((degraded+1))
    [ "${dbl:--1}" -gt "${maxdb:-0}" ] 2>/dev/null && maxdb=$dbl
  fi
  BP=$(pgrep -f "node.*tsx src/[i]ndex.ts" | wc -l); WP=$(pgrep -f "node.*tsx src/[w]orker.ts" | wc -l)
  [ "$BP" -lt 1 ] && bot_died=$((bot_died+1)); [ "$WP" -lt 1 ] && worker_died=$((worker_died+1))
  echo "sample $i/$MINUTES $(date -u +%H:%M:%S) | health=$status db=${dbl}ms ami=$ami | procs b=$BP w=$WP" | tee -a "$SOAKLOG"
  [ "$i" -lt "$MINUTES" ] && sleep 60
done

NB_ERR=$(base_err "$BLOG"); NW_ERR=$(base_err "$WLOG")
NB_RS=$(base_respawn "$BLOG"); NW_RS=$(base_respawn "$WLOG")
echo "" | tee -a "$SOAKLOG"
echo "=== SOAK SUMMARY $(date -u +%FT%TZ) ===" | tee -a "$SOAKLOG"
echo "health ok: $ok/$MINUTES | degraded: $degraded | unreachable: $unreachable" | tee -a "$SOAKLOG"
echo "max db latency seen: ${maxdb}ms" | tee -a "$SOAKLOG"
echo "bot-process dead samples: $bot_died | worker dead samples: $worker_died" | tee -a "$SOAKLOG"
echo "NEW log errors during soak: bot $((NB_ERR-BASE_BOT_ERR)) | worker $((NW_ERR-BASE_W_ERR))" | tee -a "$SOAKLOG"
echo "supervisor respawns during soak: bot $((NB_RS-BASE_B_RS)) | worker $((NW_RS-BASE_W_RS))" | tee -a "$SOAKLOG"