#!/bin/sh
# Started by the nginx image entrypoint before nginx. Supervises the storage server (restarts on exit).
mkdir -p /data/server
(
    while true; do
        bun /app/server/index.ts
        echo "[storage] exited with $?, restarting in 1s" >&2
        sleep 1
    done
) &
