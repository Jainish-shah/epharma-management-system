#!/bin/bash
# Post-deployment smoke test — run this against a LIVE deployment after every release.
#
#   bash smoketest.sh https://epharma.example.com
#
# Read-only: it checks health, the public endpoints, that the SPA is being served, that security
# headers are present and that authentication is enforced. It creates no data, so it is safe to run
# against production. (For full behaviour coverage, test.sh runs the 49-assertion suite against a
# throwaway database.)
set -e

BASE=${1:-http://127.0.0.1:8000}
BASE=${BASE%/}    # strip a trailing slash
FAILED=0

pass() { printf "  ok   %s\n" "$1"; }
fail() { printf "  FAIL %s — %s\n" "$1" "$2"; FAILED=$((FAILED+1)); }

check() {  # check <label> <actual> <expected>
  [ "$2" = "$3" ] && pass "$1" || fail "$1" "expected '$3', got '$2'"
}

echo "Smoke testing $BASE"
echo "--------------------------------------------------------------"

# 1. Health — must report ok, and tells us which database and event bus are live.
HEALTH=$(curl -fsS "$BASE/api/health" 2>/dev/null || echo '{}')
STATUS=$(echo "$HEALTH" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status","unreachable"))' 2>/dev/null || echo unreachable)
check "health endpoint reports ok" "$STATUS" "ok"
if [ "$STATUS" = "ok" ]; then
  echo "$HEALTH" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("       database=%s  payments=%s  events=%s" % (d["database"], d["paymentProvider"], d["events"]))'
fi

# 2. The React SPA is being served.
BODY=$(curl -fsS "$BASE/" 2>/dev/null || echo '')
case "$BODY" in *'<div id="root">'*) pass "SPA shell served" ;; *) fail "SPA shell served" "index.html did not contain the React root" ;; esac

# 3. Public catalog responds.
MEDS=$(curl -fsS "$BASE/api/medicines" 2>/dev/null | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo err)
[ "$MEDS" != "err" ] && pass "catalog reachable ($MEDS medicines)" || fail "catalog reachable" "no valid JSON"

# 4. Authentication is enforced on a protected endpoint.
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/notifications")
check "protected endpoint rejects anonymous" "$CODE" "401"

# 5. Admin endpoint is not publicly readable.
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/audit")
check "admin endpoint rejects anonymous" "$CODE" "401"

# 6. Unknown API routes return JSON, not an HTML error page.
ERR=$(curl -s "$BASE/api/definitely-not-a-route" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("error",""))' 2>/dev/null || echo '')
check "unknown API route returns JSON 404" "$ERR" "Endpoint not found"

# 7. Security headers. These three are sent in every environment; HSTS below is the one that only
#    appears when DJANGO_DEBUG=0, so it is the real signal that production settings are active.
HEADERS=$(curl -sI "$BASE/api/config")
for h in "X-Frame-Options" "X-Content-Type-Options" "Referrer-Policy"; do
  echo "$HEADERS" | grep -qi "$h" && pass "header $h present" || fail "header $h present" "missing — security middleware not active"
done
case "$BASE" in
  https://*)
    echo "$HEADERS" | grep -qi "Strict-Transport-Security" \
      && pass "header Strict-Transport-Security present" \
      || fail "header Strict-Transport-Security present" "missing on an HTTPS deployment"
    ;;
  *) printf "  --   HSTS check skipped (not an HTTPS URL)\n" ;;
esac

echo "--------------------------------------------------------------"
if [ "$FAILED" -eq 0 ]; then
  echo "SMOKE TEST PASSED"
else
  echo "SMOKE TEST FAILED — $FAILED check(s) failed"
  exit 1
fi
