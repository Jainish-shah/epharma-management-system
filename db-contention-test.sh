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
BASE_PORT=3960
PORT=$BASE_PORT
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

start_server() {   # start_server <workers>
  # gthread + keep-alive: sync workers close every connection, so the load generator burns one
  # ephemeral port per request and exhausts the local range long before the server is stressed.
  # Threads do not change what is being measured here — they share one database connection and one
  # lock, so database concurrency per process is still 1 and the worker process is still the unit.
  "$DIR/.venv/bin/gunicorn" epharma_site.wsgi:application \
      -b 127.0.0.1:$PORT -w "$1" --worker-class gthread --threads 8 --keep-alive 30 \
      --log-level error >"$OUT/server.log" 2>&1 &
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
  # A fresh port per step. Reusing one port meant the ~50 sockets the previous step had just torn
  # down were still in TIME_WAIT when the next server bound it, and those showed up as connection
  # failures against the new step rather than the old one.
  PORT=$(( BASE_PORT + W ))
  B="http://127.0.0.1:$PORT"
  start_server "$W" || { echo "  server failed to start with $W workers"; continue; }
  "$DIR/.venv/bin/locust" -f "$DIR/locustfile.py" --host "$B" --headless \
      -u "$USERS" -r "$USERS" -t "$DURATION" --csv "$OUT/w$W" --only-summary \
      SaturationUser >/dev/null 2>&1 || true
  stop_server
  python3 - "$OUT/w${W}_stats.csv" "$W" "$OUT/w${W}_failures.csv" <<'PY'
import csv, sys, pathlib
f = pathlib.Path(sys.argv[1])
if not f.exists():
    print(f"  {sys.argv[2]:<9} (no data)"); raise SystemExit
row = {r["Name"]: r for r in csv.DictReader(f.open())}.get("Aggregated")
print(f"  {sys.argv[2]:<9} {float(row['Requests/s']):>12.0f} {row['95%']:>12} {row['Failure Count']:>12}")
# A failure count on its own is not actionable — say what actually failed, so a connection the
# server never accepted is not mistaken for the application returning an error.
fails = pathlib.Path(sys.argv[3])
if int(row["Failure Count"]) and fails.exists():
    for r in sorted(csv.DictReader(fails.open()), key=lambda r: -int(r["Occurrences"]))[:2]:
        print(f"  {'':<9} {r['Occurrences']:>12}  {r['Error'][:60]}")
PY
done

echo ""
echo "  Reading it: throughput rising with workers confirms the worker process is the unit of"
echo "  database concurrency. A flat line would mean the bottleneck is elsewhere."
echo ""
echo "  A failure line reading \"Can't assign requested address\" is the LOAD GENERATOR running"
echo "  out of local ports, not a server error — gunicorn sync workers do not keep connections"
echo "  alive, so every request opens a fresh TCP connection and the client side fills with"
echo "  TIME_WAIT sockets. The throughput and latency figures are still valid. To remove it,"
echo "  widen the ephemeral range (macOS: sysctl -w net.inet.ip.portrange.first=16384) or use"
echo "  fewer clients. Server-side errors appear as HTTP status codes instead."

# ---------------------------------------------------------------- 1b. concurrent writes
echo ""
echo "=============================================================="
echo " 1b. CONCURRENT CHECKOUT — the hottest write path, across workers"
echo "=============================================================="
echo " 60 checkouts, 12 at a time, against 4 worker processes."
echo ""
echo " Regression guard: these transactions must take the write lock UP FRONT"
echo " (BEGIN IMMEDIATE). A deferred transaction upgrades read->write on its first"
echo " statement, and SQLite does not apply busy_timeout to that upgrade — so under"
echo " concurrent writers it fails instantly with \"database is locked\" and the"
echo " customer sees a 500 on a payment they have already made."
echo ""
PORT=$(( BASE_PORT + 20 )); B="http://127.0.0.1:$PORT"
start_server 4 || echo "  server failed to start"
"$DIR/.venv/bin/python" - "$B/api" <<'CONC'
import json, sys, urllib.request, urllib.error, collections, concurrent.futures as cf
B = sys.argv[1]

def post(path, body, tok=None):
    req = urllib.request.Request(B + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json",
                                          **({"Authorization": "Bearer " + tok} if tok else {})})
    try:
        r = urllib.request.urlopen(req)
        return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())

tok = post("/login", {"email": "priya@gmail.com", "password": "patient123"})[1]["token"]
med = json.load(urllib.request.urlopen(B + "/medicines?search=Paracetamol"))[0]["id"]

def checkout(_):
    items = [{"medicine_id": med, "qty": 1}]
    code, pay = post("/payments/create", {"items": items}, tok)
    if code != 200:
        return f"payment {code}"
    code, order = post("/orders", {"items": items, "type": "pickup",
                                   "payment": pay["demoCheckout"]}, tok)
    return "ok" if code == 200 else f"{code} {order.get('error')}"

with cf.ThreadPoolExecutor(12) as ex:
    results = list(ex.map(checkout, range(60)))

counts = collections.Counter(results)
ok = counts.get("ok", 0)
for outcome, n in counts.most_common():
    print(f"    {n:>3}  {outcome}")
print()
if ok == 60:
    print("  PASS  60/60 concurrent checkouts succeeded")
else:
    print(f"  FAIL  only {ok}/60 succeeded — the write path is not contention-safe")
    sys.exit(1)
CONC
stop_server

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
