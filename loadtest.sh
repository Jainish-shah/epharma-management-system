#!/bin/bash
# Phase 5 — load test. Starts the app on a throwaway database, hammers the hot read endpoints
# with ApacheBench, and prints throughput + latency. Usage: bash loadtest.sh [requests] [concurrency]
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
N=${1:-500}      # total requests per endpoint
C=${2:-20}       # concurrent clients
export EPHARMA_DB=$(mktemp -d)/load.db
export PORT=3998
B="http://127.0.0.1:$PORT"

"$DIR/.venv/bin/python" "$DIR/manage.py" runserver 127.0.0.1:$PORT --noreload >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; rm -rf "$(dirname "$EPHARMA_DB")"' EXIT
for i in $(seq 1 40); do curl -s "$B/api/medicines" >/dev/null && break; sleep 0.25; done

# a logged-in token, so we can also measure an authenticated endpoint
TOKEN=$(curl -s -H 'Content-Type: application/json' \
  -d '{"email":"priya@gmail.com","password":"patient123"}' $B/api/login \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

bench() {  # bench <label> <url> [auth]
  local label=$1 url=$2 auth=$3
  local out
  if [ -n "$auth" ]; then
    out=$(ab -n "$N" -c "$C" -H "Authorization: Bearer $TOKEN" "$url" 2>/dev/null)
  else
    out=$(ab -n "$N" -c "$C" "$url" 2>/dev/null)
  fi
  printf "%-26s %10s req/s   mean %8s ms   p95 %6s ms   failed: %s\n" \
    "$label" \
    "$(echo "$out" | awk '/Requests per second/{printf "%.1f", $4}')" \
    "$(echo "$out" | awk '/Time per request.*mean\)/{printf "%.1f", $4; exit}')" \
    "$(echo "$out" | awk '/^  95%/{print $2}')" \
    "$(echo "$out" | awk '/Failed requests/{print $3}')"
}

echo "Load test — $N requests, $C concurrent, $(python3 -c "import os;print('PostgreSQL' if os.environ.get('DATABASE_URL') else 'SQLite')")"
echo "-----------------------------------------------------------------------------------------"
bench "GET /api/medicines"      "$B/api/medicines"
bench "GET /api/doctors"        "$B/api/doctors"
bench "GET /api/cms/faq"        "$B/api/cms/faq"
bench "GET /api/notifications"  "$B/api/notifications" auth
bench "GET / (SPA shell)"       "$B/"
echo "-----------------------------------------------------------------------------------------"
echo "Note: Django's dev server is single-process; production should run gunicorn/uvicorn workers."
