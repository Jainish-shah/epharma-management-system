#!/bin/bash
# Database concurrency and connection-exhaustion test.
#
#   bash db-contention-test.sh                                  # SQLite, worker-scaling only
#   DATABASE_URL=postgresql://user@host/db bash db-contention-test.sh   # adds the PostgreSQL tests
#
# WHAT IS ACTUALLY BEING TESTED
#
# This application has no connection pool. api/db.py opens ONE connection at module import and
# guards it with a single global lock, so:
#
#   * inside a worker process, database access is serialised — concurrency is 1, however many
#     threads the server has;
#   * the unit of database concurrency is therefore the WORKER PROCESS, and total connections held
#     equals (workers x containers).
#
# "Pool exhaustion" in the usual sense (a pool of K connections, the K+1th caller queues or fails)
# cannot happen, because there is no pool. The two real limits are measured instead:
#
#   1. worker scaling   — does throughput scale with workers? (it should, if the process is the
#                         unit of concurrency)
#   2. server refusal   — what happens when PostgreSQL will not grant a connection, which is what
#                         max_connections exhaustion looks like from the client side
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
DURATION=${1:-15s}
USERS=${2:-50}
PORT=3996
B="http://127.0.0.1:$PORT"
OUT=$(mktemp -d)

if [ ! -x "$DIR/.venv/bin/locust" ]; then
  echo "locust is not installed in .venv (it is a test tool, not a runtime dependency)."
  echo "Install it with:"
  echo "    .venv/bin/pip install locust"
  exit 1
fi

export DJANGO_SECRET_KEY=contention-test-only
export RATE_LIMIT_ENABLED=0          # measuring the database, not the rate limiter
export PYTHONUNBUFFERED=1
[ -z "$DATABASE_URL" ] && export EPHARMA_DB="$OUT/contention.db"

BACKEND="SQLite"; [ -n "$DATABASE_URL" ] && BACKEND="PostgreSQL"
echo "Backend: $BACKEND"
echo ""

stop_server() { kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; }
trap 'stop_server; rm -rf "$OUT"' EXIT

# Wait until EVERY worker can serve, not just the first one to answer.
# /api/health succeeding proves only that ONE worker finished importing; the siblings may still be
# opening their database connection. Measuring through that window reports the harness's own
# start-up race as application failures — which it did, until this was added.
wait_ready() {   # wait_ready <workers>
  local workers=$1 attempt ok i
  for attempt in $(seq 1 40); do
    ok=1
    for i in $(seq 1 $(( workers * 5 ))); do
      curl -sf -m 2 "$B/api/medicines" >/dev/null 2>&1 || { ok=0; break; }
    done
    [ "$ok" = 1 ] && return 0
    sleep 0.5
  done
  return 1
}

start_server() {   # start_server <workers>
  "$DIR/.venv/bin/gunicorn" epharma_site.wsgi:application \
      -b 127.0.0.1:$PORT -w "$1" --log-level error >"$OUT/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do curl -s "$B/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
  wait_ready "$1"
}

# ---------------------------------------------------------------- 1. worker scaling
echo "=============================================================="
echo " 1. WORKER SCALING — is the process the unit of DB concurrency?"
echo "=============================================================="
echo " $USERS saturating clients, $DURATION per step."
echo ""
printf "  %-9s %12s %12s %12s\n" "workers" "req/s" "p95 (ms)" "failures"

for W in 1 2 4 8; do
  start_server "$W" || { echo "  server failed to start with $W workers"; continue; }
  "$DIR/.venv/bin/locust" -f "$DIR/locustfile.py" --host "$B" --headless \
      -u "$USERS" -r "$USERS" -t "$DURATION" --csv "$OUT/w$W" --only-summary \
      SaturationUser >/dev/null 2>&1 || true
  stop_server
  python3 - "$OUT/w${W}_stats.csv" "$W" <<'PY'
import csv, sys, pathlib
f = pathlib.Path(sys.argv[1])
if not f.exists():
    print(f"  {sys.argv[2]:<9} (no data)"); raise SystemExit
row = {r["Name"]: r for r in csv.DictReader(f.open())}.get("Aggregated")
print(f"  {sys.argv[2]:<9} {float(row['Requests/s']):>12.0f} {row['95%']:>12} {row['Failure Count']:>12}")
PY
done

echo ""
echo "  Reading it: throughput rising with workers confirms the worker process is the unit of"
echo "  database concurrency. A flat line would mean the bottleneck is elsewhere."

# ---------------------------------------------------------------- 2. connection refusal
echo ""
echo "=============================================================="
echo " 2. CONNECTION REFUSAL — the failure mode under exhaustion"
echo "=============================================================="

# An unreachable database is indistinguishable, from the client's side, from a server that has run
# out of connection slots: psycopg.connect() raises either way.
DATABASE_URL="postgresql://nobody@127.0.0.1:5999/unreachable" \
  "$DIR/.venv/bin/gunicorn" epharma_site.wsgi:application -b 127.0.0.1:3995 -w 1 \
  --log-level error >"$OUT/refused.log" 2>&1 &
REFUSED_PID=$!
sleep 6
CODE=$(curl -s -m 3 -o /dev/null -w "%{http_code}" http://127.0.0.1:3995/api/health || true)
kill $REFUSED_PID 2>/dev/null || true

echo ""
if [ "$CODE" = "503" ]; then
  echo "  /api/health returned 503 — the process stayed up and reported itself unhealthy."
  echo "  A load balancer can route around it, and it recovers on its own when the database returns."
elif [ "$CODE" = "000" ]; then
  echo "  /api/health did not respond at all: HTTP $CODE."
  echo ""
  echo "  The connection is opened at MODULE IMPORT (api/db.py), so a worker that cannot reach the"
  echo "  database dies before it can serve anything — including the health endpoint that exists to"
  echo "  report exactly this condition. Under PostgreSQL connection exhaustion the workers"
  echo "  crash-loop instead of degrading, and gunicorn gives up after its retry budget."
  echo ""
  echo "  Worker log:"
  grep -iE "refus|could not connect|Exception in worker|Worker failed to boot" "$OUT/refused.log" \
    | head -3 | sed 's/^/    /'
else
  echo "  /api/health returned HTTP $CODE."
fi

# ---------------------------------------------------------------- 3. real PostgreSQL limits
if [ -n "$DATABASE_URL" ]; then
  echo ""
  echo "=============================================================="
  echo " 3. POSTGRESQL CONNECTION BUDGET"
  echo "=============================================================="
  "$DIR/.venv/bin/python" - <<'PY'
import os, psycopg
with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as c:
    mx = c.execute("SHOW max_connections").fetchone()[0]
    rsv = c.execute("SHOW superuser_reserved_connections").fetchone()[0]
    used = c.execute("SELECT count(*) FROM pg_stat_activity").fetchone()[0]
    print(f"  max_connections              {mx}")
    print(f"  superuser_reserved           {rsv}")
    print(f"  currently in use             {used}")
    budget = int(mx) - int(rsv)
    print(f"  available to this app        {budget}")
    print()
    print(f"  This app holds ONE connection per worker process, so the ceiling is {budget} worker")
    print(f"  processes in total across every container. Exceeding it makes new workers fail to")
    print(f"  boot (see section 2), not merely queue.")
PY
fi

echo ""
echo "=============================================================="
echo " Done."
echo "=============================================================="
