#!/bin/bash
# Deployment verification — builds and runs the PRODUCTION stack (docker-compose.prod.yml), then
# proves the properties a read-only smoke test cannot see:
#
#   1. the stack builds, starts and passes smoketest.sh
#   2. WEB_CONCURRENCY actually sets the worker count
#   3. every setting in .env.example reaches the container
#   4. behind a proxy, rate limiting is per client — not one bucket shared by everyone
#   5. a PostgreSQL restart heals itself, with no container restart
#   6. the app starts with NO database, reports 503, and seeds itself when the database appears
#
#   bash deploy-verify.sh
#
# Needs Docker. Uses its own compose project, port and throwaway secrets, and removes the
# stack and its volume on exit — it never touches a real deployment or its data.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT=epharma-verify
PORT=8095
URL="http://127.0.0.1:$PORT"
WORKERS=4
ENV_FILE=$(mktemp)

python3 - > "$ENV_FILE" <<PY
import secrets
print(f"POSTGRES_PASSWORD={secrets.token_urlsafe(24)}")
print(f"DJANGO_SECRET_KEY={secrets.token_urlsafe(64)}")
print(f"EPHARMA_ENC_KEY={secrets.token_urlsafe(48)}")
print("DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1")
print("WEB_PORT=$PORT")
print("WEB_CONCURRENCY=$WORKERS")
print("DJANGO_TRUST_PROXY=1")
PY

dc() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$DIR/docker-compose.prod.yml" "$@"; }
trap 'dc down -v >/dev/null 2>&1 || true; rm -f "$ENV_FILE"' EXIT

PASSED=0; FAILED=0
pass() { printf "  ok    %s\n" "$1"; PASSED=$((PASSED + 1)); }
fail() { printf "  FAIL  %s — %s\n" "$1" "$2"; FAILED=$((FAILED + 1)); }
check() { [ "$2" = "$3" ] && pass "$1" || fail "$1" "expected '$3', got '$2'"; }

code() { curl -s -o /dev/null -m 5 -w '%{http_code}' "$URL$1"; }
wait_for() {   # wait_for <path> <status> <seconds>
  for _ in $(seq 1 "$3"); do [ "$(code "$1")" = "$2" ] && return 0; sleep 1; done; return 1
}
web() { docker inspect -f "$1" "$PROJECT-web-1"; }

docker info >/dev/null 2>&1 || { echo "Docker is not running."; exit 1; }
echo "Verifying the production stack (project $PROJECT, port $PORT)"
echo "--------------------------------------------------------------"

# ---------------------------------------------------------------- 1. build and start
dc up -d --build >/dev/null 2>&1
wait_for /api/health 200 90 && pass "stack builds and becomes healthy" || fail "stack builds and becomes healthy" "no 200 from /api/health"
check "running on PostgreSQL" "$(curl -s "$URL/api/health" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("database"))')" "postgresql"
bash "$DIR/smoketest.sh" "$URL" >/dev/null 2>&1 && pass "smoketest.sh passes" || fail "smoketest.sh passes" "run it directly for detail"

# ---------------------------------------------------------------- 2. worker count
RUNNING=$(docker exec "$PROJECT-web-1" python -c "
import os
me = str(os.getpid())
print(sum(1 for p in os.listdir('/proc') if p.isdigit() and p != me
          and b'gunicorn' in open(f'/proc/{p}/cmdline', 'rb').read()) - 1)")
check "WEB_CONCURRENCY sets the worker count" "$RUNNING" "$WORKERS"

# ---------------------------------------------------------------- 3. settings pass-through
# Compose forwards only the variables it lists; anything else in .env is silently dropped.
# Every application setting in .env.example must therefore appear in the web service's environment.
CONFIGURED=$(dc config --format json | python3 -c 'import sys,json;print(" ".join(json.load(sys.stdin)["services"]["web"]["environment"]))')
MISSING=""
for var in $(grep -oE '^[A-Z][A-Z0-9_]*=' "$DIR/.env.example" | tr -d '=' | grep -vE '^(POSTGRES_|WEB_PORT$)'); do
  case " $CONFIGURED " in *" $var "*) ;; *) MISSING="$MISSING $var" ;; esac
done
[ -z "$MISSING" ] && pass "every .env.example setting reaches the container" \
                  || fail "every .env.example setting reaches the container" "not passed through:$MISSING"

# ---------------------------------------------------------------- 4. rate limiting behind a proxy
login() {  # login <client-ip> -> HTTP status
  curl -s -o /dev/null -w '%{http_code}' -H "X-Forwarded-For: $1" -H 'Content-Type: application/json' \
       -d '{"email":"nobody@example.com","password":"wrong"}' "$URL/api/login"
}
THROTTLED=0
for i in $(seq 1 40); do [ "$(login "203.0.113.$i")" = 429 ] && THROTTLED=$((THROTTLED + 1)); done
check "40 different clients are not throttled as one" "$THROTTLED" "0"
THROTTLED=0
for i in $(seq 1 $(( WORKERS * 10 + 20 ))); do [ "$(login 198.51.100.7)" = 429 ] && THROTTLED=$((THROTTLED + 1)); done
[ "$THROTTLED" -gt 0 ] && pass "a single abusive client is still throttled ($THROTTLED refused)" \
                       || fail "a single abusive client is still throttled" "no 429 returned"

# ---------------------------------------------------------------- 5. database restart
docker restart "$PROJECT-db-1" >/dev/null
for _ in $(seq 1 30); do docker exec "$PROJECT-db-1" pg_isready -q 2>/dev/null && break; sleep 1; done
wait_for /api/health 200 30 && pass "recovers from a PostgreSQL restart within 30s" \
                             || fail "recovers from a PostgreSQL restart within 30s" "health never returned 200"
check "…without restarting the web container" "$(web '{{.RestartCount}}')" "0"

# ---------------------------------------------------------------- 6. start with no database
dc down -v >/dev/null 2>&1
dc up -d --no-deps web >/dev/null 2>&1
wait_for /api/health 503 60 && pass "starts with no database and reports 503" \
                             || fail "starts with no database and reports 503" "health was not 503"
check "…and stays running rather than crash-looping" "$(web '{{.State.Status}}')/$(web '{{.RestartCount}}')" "running/0"
dc up -d db >/dev/null 2>&1
wait_for /api/health 200 60 && pass "becomes healthy once the database appears" \
                             || fail "becomes healthy once the database appears" "health never returned 200"
check "…creating the schema and seeding an empty database" \
      "$(curl -s "$URL/api/medicines" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')" "12"

echo "--------------------------------------------------------------"
if [ "$FAILED" -eq 0 ]; then
  echo "DEPLOYMENT VERIFIED  ($PASSED checks)"
else
  echo "$PASSED passed, $FAILED FAILED"
  echo "Stack logs: docker compose -p $PROJECT logs web   (the stack is removed on exit)"
  exit 1
fi
