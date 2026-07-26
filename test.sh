#!/bin/bash
# End-to-end API test: fresh throwaway DB, full workflow across all four roles.
# Usage: npm test  (exits non-zero on first failure)
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
export EPHARMA_DB=$(mktemp -d)/test.db
export PORT=3999
B="http://localhost:$PORT/api"
J='-H Content-Type:application/json'

node "$DIR/server.js" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; rm -rf "$(dirname "$EPHARMA_DB")"' EXIT
for i in $(seq 1 20); do curl -s "$B/medicines" >/dev/null && break; sleep 0.25; done

jget() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }
assert_eq() { [ "$1" = "$2" ] || { echo "FAIL: $3 (expected '$2', got '$1')"; exit 1; }; echo "ok: $3"; }

# --- patient: login, order, book appointment ---
PT=$(curl -s $J -d '{"email":"priya@gmail.com","password":"patient123"}' $B/login | jget '["token"]')
assert_eq "${#PT}" "48" "patient login returns token"

BAD=$(curl -s $J -d '{"email":"priya@gmail.com","password":"wrong"}' $B/login | jget '["error"]')
assert_eq "$BAD" "Invalid email or password" "wrong password rejected"

ORDER=$(curl -s $J -H "Authorization: Bearer $PT" \
  -d '{"items":[{"medicine_id":1,"qty":2}],"type":"delivery","address":"Test Lane"}' $B/orders)
assert_eq "$(echo "$ORDER" | jget '["status"]')" "pending" "order placed"
OID=$(echo "$ORDER" | jget '["id"]')

STOCK=$(curl -s "$B/medicines?search=Paracetamol" | jget '[0]["stock"]')
assert_eq "$STOCK" "198" "stock decremented after order"

OVERSELL=$(curl -s $J -H "Authorization: Bearer $PT" \
  -d '{"items":[{"medicine_id":1,"qty":9999}],"type":"pickup"}' $B/orders | jget '["error"][:4]')
assert_eq "$OVERSELL" "Only" "overselling blocked"

APPT=$(curl -s $J -H "Authorization: Bearer $PT" -d '{"doctor_id":2,"slot":"2026-07-15 · Mon 10:00"}' $B/appointments)
AID=$(echo "$APPT" | jget '["id"]')
assert_eq "$(echo "$APPT" | jget '["status"]')" "pending" "appointment booked"

# --- pharmacy: advance order ---
PH=$(curl -s $J -d '{"email":"store@medplus.com","password":"pharma123"}' $B/login | jget '["token"]')
S=$(curl -s -X PATCH -H "Authorization: Bearer $PH" $B/orders/$OID | jget '["status"]')
assert_eq "$S" "preparing" "pharmacy advanced order"

# --- doctor: confirm appointment, write prescription ---
DR=$(curl -s $J -d '{"email":"asha@epharma.com","password":"doctor123"}' $B/login | jget '["token"]')
S=$(curl -s -X PATCH $J -H "Authorization: Bearer $DR" -d '{"status":"confirmed"}' $B/appointments/$AID | jget '["status"]')
assert_eq "$S" "confirmed" "doctor confirmed appointment"

RX=$(curl -s $J -H "Authorization: Bearer $DR" -d "{\"appointment_id\":$AID,\"content\":\"Rx test\"}" $B/prescriptions | jget '["kind"]')
assert_eq "$RX" "eprescription" "e-prescription created"

N=$(curl -s -H "Authorization: Bearer $PT" $B/prescriptions | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")
assert_eq "$N" "1" "patient sees prescription"

# --- RBAC: patient cannot touch admin/pharmacy routes ---
DENIED=$(curl -s -H "Authorization: Bearer $PT" $B/admin/stats | jget '["error"]')
assert_eq "$DENIED" "Not allowed for your role" "patient blocked from admin stats"
DENIED=$(curl -s -X PATCH -H "Authorization: Bearer $PT" $B/orders/$OID | jget '["error"]')
assert_eq "$DENIED" "Not allowed for your role" "patient blocked from advancing orders"
DENIED=$(curl -s $B/notifications | jget '["error"]')
assert_eq "$DENIED" "Please log in" "anonymous blocked"

# --- admin: approve pending doctor ---
AD=$(curl -s $J -d '{"email":"admin@epharma.com","password":"admin123"}' $B/login | jget '["token"]')
S=$(curl -s -X PATCH $J -H "Authorization: Bearer $AD" -d '{"status":"approved"}' $B/admin/users/4 | jget '["status"]')
assert_eq "$S" "approved" "admin approved pending doctor"
REV=$(curl -s -H "Authorization: Bearer $AD" $B/admin/stats | jget '["revenue"]')
assert_eq "$REV" "60" "admin stats revenue correct"

# ============ Phase 2: OTP, validation, documents ============

# --- OTP-verified patient registration ---
NEWMAIL="newpatient@test.com"
OTP=$(curl -s $J -d "{\"email\":\"$NEWMAIL\"}" $B/register/send-otp | jget '["devOtp"]')
assert_eq "${#OTP}" "6" "send-otp returns 6-digit demo code"

NOOTP=$(curl -s $J -d "{\"role\":\"patient\",\"name\":\"New P\",\"email\":\"$NEWMAIL\",\"password\":\"secret1\"}" $B/register | jget '["error"][:7]')
assert_eq "$NOOTP" "Invalid" "patient register without OTP blocked"

BADOTP=$(curl -s $J -d "{\"role\":\"patient\",\"name\":\"New P\",\"email\":\"$NEWMAIL\",\"password\":\"secret1\",\"otp\":\"000000\"}" $B/register | jget '["error"][:7]')
assert_eq "$BADOTP" "Invalid" "patient register with wrong OTP blocked"

REG=$(curl -s $J -d "{\"role\":\"patient\",\"name\":\"New P\",\"email\":\"$NEWMAIL\",\"password\":\"secret1\",\"otp\":\"$OTP\"}" $B/register | jget '["user"]["status"]')
assert_eq "$REG" "approved" "patient register with valid OTP succeeds"

# --- input validation ---
SHORT=$(curl -s $J -d '{"role":"patient","name":"X","email":"x@y.com","password":"123"}' $B/register | jget '["error"][:8]')
assert_eq "$SHORT" "Password" "short password rejected"

BADMAIL=$(curl -s $J -d '{"role":"patient","name":"X","email":"notanemail","password":"secret1"}' $B/register | jget '["error"]')
assert_eq "$BADMAIL" "A valid email is required" "invalid email rejected"

DOCREQ=$(curl -s $J -d '{"role":"doctor","name":"Dr X","email":"drx@test.com","password":"secret1"}' $B/register | jget '["error"][:7]')
assert_eq "$DOCREQ" "Doctors" "doctor missing qualification rejected"

BADPRICE=$(curl -s $J -H "Authorization: Bearer $PH" -d '{"name":"Test Med","category":"Test","price":-5}' $B/medicines | jget '["error"][:5]')
assert_eq "$BADPRICE" "Price" "negative medicine price rejected"

# --- error handling ---
NOTFOUND=$(curl -s $B/does-not-exist | jget '["error"]')
assert_eq "$NOTFOUND" "Endpoint not found" "unknown API route returns JSON 404"

# --- verification document upload ---
DDOC=$(curl -s $J -H "Authorization: Bearer $DR" -d '{"documents":{"Degree":"data:image/png;base64,iVBORw0KGgo="}}' $B/me/documents | jget '["ok"]')
assert_eq "$DDOC" "True" "doctor uploads verification documents"

PTDOC=$(curl -s $J -H "Authorization: Bearer $PT" -d '{"documents":{"x":"y"}}' $B/me/documents | jget '["error"]')
assert_eq "$PTDOC" "Not allowed for your role" "patient blocked from document upload"

echo ""
echo "ALL TESTS PASSED"
