#!/bin/bash
# Estrae tutte le trascrizioni delle interviste dai log Render.
KEY="${RENDER_KEY:?esporta RENDER_KEY=rnd_...}"
SVC=srv-d8sji16gvqtc738au9ag; OWNER=tea-d7plj077f7vs739nnthg
curl -s -H "Authorization: Bearer $KEY" \
  "https://api.render.com/v1/logs?ownerId=$OWNER&resource=$SVC&limit=200&direction=backward" \
| jq -r '.logs[].message' \
| grep -o 'transcript (no webhook): .*' \
| sed 's/^transcript (no webhook): //' \
| jq -r '"\n===== \(.sessionId)  \(.startedAt)  (turni: \(.turnCount)) =====", (.turns[] | "\(if .role=="user" then "TU" else "INTERVISTATORE" end): \(.text)")'
