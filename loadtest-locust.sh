#!/bin/bash
# Concurrent-user load test (Locust) against a throwaway instance.
#
#   bash loadtest-locust.sh                 # defaults: 100 users, 60s, 4 workers
#   bash loadtest-locust.sh 200 90s 8       # users, duration, gunicorn workers
#   DATABASE_URL=postgresql://... bash loadtest-locust.sh    # run against PostgreSQL
#
# Runs three scenarios:
#   1. realistic    — rate limiting OFF, mixed traffic with human think time. How the service
#                     behaves under N actual users.
#   2. saturation   — rate limiting OFF, no think time. The throughput ceiling and where it bends.
#   3. rate limit   — rate limiting ON, abusive clients. Proves excess load is shed with 429
#                     instead of degrading the service for everyone else.
#
# Uses gunicorn (not the Django dev server) because the dev server is single-process and would
# measure the wrong thing entirely.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
USERS=${1:-100}
DURATION=${2:-60s}
WORKERS=${3:-4}
PORT=3997
B="http://127.0.0.1:$PORT"
OUT=$(mktemp -d)

if [ ! -x "$DIR/.venv/bin/locust" ]; then
  echo "locust is not installed in .venv (it is a test tool, not a runtime dependency)."
  echo "Install it with:"
  echo "    .venv/bin/pip install locust"
  exit 1
fi

export EPHARMA_DB="$OUT/load.db"
export DJANGO_SECRET_KEY=loadtest-only-not-secret
export PYTHONUNBUFFERED=1

if [ -n "$DATABASE_URL" ]; then
  echo "Backend: PostgreSQL"
else
  echo "Backend: SQLite ($EPHARMA_DB)"
fi
echo "Server:  gunicorn, $WORKERS worker(s) on port $PORT"
echo "Load:    $USERS concurrent users for $DURATION"
echo ""

# Wait until EVERY worker can serve, not just the first one to answer.
# /api/health succeeding proves only that ONE worker finished importing; the siblings may still be
# opening their database connection. Measuring through that window reports the harness's own
# start-up race as application failures — which it did, until this was added.
wait_ready() {   # wait_ready <workers>
  # Sequential probes are not enough: gunicorn hands each connection to whichever worker accepts
  # first, so a serial warm-up can be answered entirely by the workers that are already up while a
  # sibling is still importing. Fire a burst WIDER than the worker count in parallel — that forces
  # the kernel to spread the connections — and require two clean bursts in a row before measuring.
  local workers=$1 burst=$(( workers * 6 )) attempt clean=0
  for attempt in $(seq 1 60); do
    if seq 1 $burst | xargs -P "$burst" -I{} curl -sf -m 3 -o /dev/null "$B/api/medicines"; then
      clean=$(( clean + 1 ))
      [ "$clean" -ge 2 ] && return 0
    else
      clean=0
    fi
    sleep 0.5
  done
  return 1
}

start_server() {   # start_server <extra env assignments...>
  # gthread + keep-alive so the load generator does not exhaust its ephemeral ports; see the
  # note in db-contention-test.sh.
  env "$@" "$DIR/.venv/bin/gunicorn" epharma_site.wsgi:application \
      -b 127.0.0.1:$PORT -w "$WORKERS" --worker-class gthread --threads 8 --keep-alive 30 \
      --log-level error >"$OUT/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    curl -s "$B/api/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
  wait_ready "$WORKERS" && return 0
  echo "server failed to become ready:"; cat "$OUT/server.log"; exit 1
}

stop_server() { kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; }
trap 'stop_server; rm -rf "$OUT"' EXIT

run_locust() {     # run_locust <tag> <users> <duration> [locust user classes...]
  local tag=$1 users=$2 dur=$3; shift 3
  "$DIR/.venv/bin/locust" -f "$DIR/locustfile.py" --host "$B" \
      --headless -u "$users" -r "$(( users / 4 + 1 ))" -t "$dur" \
      --csv "$OUT/$tag" --only-summary "$@" 2>&1 | grep -vE "^\[|Type +Name" || true
}

# ---------------------------------------------------------------- 1. realistic
echo "=============================================================="
echo " 1. REALISTIC  — $USERS users with think time, no rate limiting"
echo "=============================================================="
start_server RATE_LIMIT_ENABLED=0
curl -s "$B/api/health"; echo; echo
# Name the paced classes explicitly: SaturationUser has no think time and would otherwise be
# mixed in by weight, inflating this scenario into a saturation run.
run_locust realistic "$USERS" "$DURATION" AnonymousBrowser PatientUser PharmacyUser
stop_server
echo ""

# ---------------------------------------------------------------- 2. saturation
echo "=============================================================="
echo " 2. SATURATION — no think time: the throughput ceiling"
echo "=============================================================="
start_server RATE_LIMIT_ENABLED=0
run_locust saturation "$USERS" "$DURATION" SaturationUser
stop_server
echo ""

# ---------------------------------------------------------------- 3. rate limit
echo "=============================================================="
echo " 3. RATE LIMIT — limiting enabled, abusive clients"
echo "=============================================================="
echo "Limit: 120 requests/minute per client on the default tier."
start_server RATE_LIMIT_ENABLED=1 RATE_LIMIT=120 RATE_LIMIT_AUTH=10
run_locust ratelimit 20 30s SaturationUser
stop_server
echo ""

echo "=============================================================="
echo " Summary"
echo "=============================================================="
python3 - "$OUT" <<'PY'
import csv, sys, pathlib
out = pathlib.Path(sys.argv[1])
for tag, label in (("realistic", "Realistic load (with think time)"),
                   ("saturation", "Saturation (no think time — the ceiling)"),
                   ("ratelimit", "Under rate limiting")):
    f = out / f"{tag}_stats.csv"
    if not f.exists():
        continue
    rows = {r["Name"]: r for r in csv.DictReader(f.open())}
    agg = rows.get("Aggregated")
    if not agg:
        continue
    print(f"\n{label}")
    print(f"  requests      {agg['Request Count']}   failures {agg['Failure Count']}")
    print(f"  throughput    {float(agg['Requests/s']):.0f} req/s")
    print(f"  latency       median {agg['Median Response Time']} ms · "
          f"p95 {agg['95%']} ms · p99 {agg['99%']} ms · max {float(agg['Max Response Time']):.0f} ms")
PY
echo ""
echo "Full CSVs were written under $OUT (removed on exit — pass --csv yourself to keep them)."
