#!/bin/bash
# End-to-end API test: fresh throwaway DB, full workflow across all four roles.
# Usage: npm test  (exits non-zero on first failure)
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
export EPHARMA_DB=$(mktemp -d)/test.db
export PORT=3999
export REFILL_DAYS=0   # refills immediately due, so the materialisation path is testable in one run
B="http://localhost:$PORT/api"
J='-H Content-Type:application/json'

"$DIR/.venv/bin/python" "$DIR/manage.py" runserver 127.0.0.1:$PORT --noreload >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; rm -rf "$(dirname "$EPHARMA_DB")"' EXIT
for i in $(seq 1 40); do curl -s "$B/medicines" >/dev/null && break; sleep 0.25; done

jget() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }
assert_eq() { [ "$1" = "$2" ] || { echo "FAIL: $3 (expected '$2', got '$1')"; exit 1; }; echo "ok: $3"; }

# Phase 3: create a payment intent for the given items, then place the paid order. Echoes order JSON.
# Provider-neutral: passes the opaque demoCheckout object straight back as `payment`.
# $1 token · $2 items JSON array · $3 extra order fields as a JSON object (e.g. '{"type":"pickup"}')
pay_and_order() {
  local tok=$1 items=$2 extra=${3:-'{}'}
  local pay body
  pay=$(curl -s $J -H "Authorization: Bearer $tok" -d "{\"items\":$items}" $B/payments/create)
  body=$(python3 -c "import json,sys
pay=json.loads(sys.argv[1]); items=json.loads(sys.argv[2]); extra=json.loads(sys.argv[3])
print(json.dumps({**extra, 'items': items, 'payment': pay['demoCheckout']}))" "$pay" "$items" "$extra")
  curl -s $J -H "Authorization: Bearer $tok" -d "$body" $B/orders
}

# --- patient: login, order, book appointment ---
PT=$(curl -s $J -d '{"email":"priya@gmail.com","password":"patient123"}' $B/login | jget '["token"]')
assert_eq "${#PT}" "48" "patient login returns token"

BAD=$(curl -s $J -d '{"email":"priya@gmail.com","password":"wrong"}' $B/login | jget '["error"]')
assert_eq "$BAD" "Invalid email or password" "wrong password rejected"

NOPAY=$(curl -s $J -H "Authorization: Bearer $PT" \
  -d '{"items":[{"medicine_id":1,"qty":1}],"type":"pickup"}' $B/orders | jget '["error"]')
assert_eq "$NOPAY" "Payment required" "order without payment rejected"

ORDER=$(pay_and_order "$PT" '[{"medicine_id":1,"qty":2}]' '{"type":"delivery","address":"Test Lane"}')
assert_eq "$(echo "$ORDER" | jget '["status"]')" "pending" "order placed after payment verified"
OID=$(echo "$ORDER" | jget '["id"]')

STOCK=$(curl -s "$B/medicines?search=Paracetamol" | jget '[0]["stock"]')
assert_eq "$STOCK" "198" "stock decremented after order"

OVERSELL=$(curl -s $J -H "Authorization: Bearer $PT" \
  -d '{"items":[{"medicine_id":1,"qty":9999}]}' $B/payments/create | jget '["error"][:4]')
assert_eq "$OVERSELL" "Only" "overselling blocked at payment"

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

NOOTP=$(curl -s $J -d "{\"role\":\"patient\",\"name\":\"New P\",\"email\":\"$NEWMAIL\",\"password\":\"secret1\",\"consent\":true}" $B/register | jget '["error"][:7]')
assert_eq "$NOOTP" "Invalid" "patient register without OTP blocked"

BADOTP=$(curl -s $J -d "{\"role\":\"patient\",\"name\":\"New P\",\"email\":\"$NEWMAIL\",\"password\":\"secret1\",\"otp\":\"000000\",\"consent\":true}" $B/register | jget '["error"][:7]')
assert_eq "$BADOTP" "Invalid" "patient register with wrong OTP blocked"

REG=$(curl -s $J -d "{\"role\":\"patient\",\"name\":\"New P\",\"email\":\"$NEWMAIL\",\"password\":\"secret1\",\"otp\":\"$OTP\",\"consent\":true}" $B/register | jget '["user"]["status"]')
assert_eq "$REG" "approved" "patient register with valid OTP succeeds"

# --- input validation ---
SHORT=$(curl -s $J -d '{"role":"patient","name":"X","email":"x@y.com","password":"123","consent":true}' $B/register | jget '["error"][:8]')
assert_eq "$SHORT" "Password" "short password rejected"

BADMAIL=$(curl -s $J -d '{"role":"patient","name":"X","email":"notanemail","password":"secret1","consent":true}' $B/register | jget '["error"]')
assert_eq "$BADMAIL" "A valid email is required" "invalid email rejected"

DOCREQ=$(curl -s $J -d '{"role":"doctor","name":"Dr X","email":"drx@test.com","password":"secret1","consent":true}' $B/register | jget '["error"][:7]')
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

# ============ Phase 3: payments, consultation, refills ============

# --- payment provider + signature verification ---
CFG=$(curl -s $B/config | jget '["paymentProvider"]')
assert_eq "$CFG" "stripe" "config exposes active payment provider (stripe)"

PC=$(curl -s $J -H "Authorization: Bearer $PT" -d '{"items":[{"medicine_id":5,"qty":1}]}' $B/payments/create)
assert_eq "$(echo "$PC" | jget '["provider"]')" "stripe" "payment intent uses stripe"
POID=$(echo "$PC" | jget '["providerOrderId"]')
assert_eq "${POID:0:3}" "pi_" "stripe PaymentIntent id issued"

BADBODY=$(python3 -c "import json,sys
pc=json.loads(sys.argv[1]); dc=dict(pc['demoCheckout'])
for k in ('proof','razorpay_signature'):
    if k in dc: dc[k]='tampered'
print(json.dumps({'items':[{'medicine_id':5,'qty':1}],'type':'pickup','payment':dc}))" "$PC")
BADSIG=$(curl -s $J -H "Authorization: Bearer $PT" -d "$BADBODY" $B/orders | jget '["error"]')
assert_eq "$BADSIG" "Payment verification failed" "tampered payment rejected"

# --- event stream: a paid order emits a receipt notification (payments -> notifications topic) ---
RCPT=$(curl -s -H "Authorization: Bearer $PT" $B/notifications | python3 -c "import sys,json;print(any('Payment received' in n['message'] for n in json.load(sys.stdin)))")
assert_eq "$RCPT" "True" "payment event produces a receipt notification"

# --- teleconsultation chat (AID is a confirmed/completed appointment between PT and DR) ---
MSG=$(curl -s $J -H "Authorization: Bearer $PT" -d '{"body":"Hello doctor"}' $B/appointments/$AID/messages | jget '["body"]')
assert_eq "$MSG" "Hello doctor" "patient sends consultation message"

curl -s $J -H "Authorization: Bearer $DR" -d '{"body":"Take rest"}' $B/appointments/$AID/messages >/dev/null
MSGS=$(curl -s -H "Authorization: Bearer $DR" $B/appointments/$AID/messages | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")
assert_eq "$MSGS" "2" "both parties see the consultation thread"

OTHER=$(curl -s $J -d "{\"email\":\"$NEWMAIL\",\"password\":\"secret1\"}" $B/login | jget '["token"]')
DENY=$(curl -s -H "Authorization: Bearer $OTHER" $B/appointments/$AID/messages | jget '["error"]')
assert_eq "$DENY" "Appointment not found" "non-party blocked from consultation thread"

# --- video room ---
ROOM=$(curl -s -H "Authorization: Bearer $PT" $B/appointments/$AID/room | jget '["url"][:21]')
assert_eq "$ROOM" "https://meet.jit.si/e" "jitsi video room url issued"

# --- refill reminders (REFILL_DAYS=0 so the reminder is immediately due) ---
REFILLS=$(curl -s -H "Authorization: Bearer $PT" $B/refills | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")
assert_eq "$REFILLS" "1" "refill reminder created for ordered medicine"

curl -s -H "Authorization: Bearer $PT" $B/notifications >/dev/null  # triggers due-refill materialisation
REFILLNOTE=$(curl -s -H "Authorization: Bearer $PT" $B/notifications | python3 -c "import sys,json;print(any('Refill reminder' in n['message'] for n in json.load(sys.stdin)))")
assert_eq "$REFILLNOTE" "True" "due refill reminder surfaces as a notification"

# ============ Phase 4: reporting, taxonomy, CMS ============

REP=$(curl -s -H "Authorization: Bearer $AD" $B/admin/reports)
assert_eq "$(echo "$REP" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("revenue_by_day" in d and "top_medicines" in d)')" "True" "admin reports returns aggregates"
assert_eq "$(echo "$REP" | jget '["top_medicines"][0]["name"][:11]')" "Paracetamol" "reports rank top medicine by units"

CATS=$(curl -s "$B/taxonomy?type=category" | python3 -c 'import sys,json;print(len(json.load(sys.stdin))>0)')
assert_eq "$CATS" "True" "taxonomy seeds categories"

curl -s $J -H "Authorization: Bearer $AD" -d '{"type":"specialty","name":"Neurology"}' $B/admin/taxonomy >/dev/null
NEURO=$(curl -s "$B/taxonomy?type=specialty" | python3 -c "import sys,json;print(any(t['name']=='Neurology' for t in json.load(sys.stdin)))")
assert_eq "$NEURO" "True" "admin adds a specialty to taxonomy"

TAXDENY=$(curl -s $J -H "Authorization: Bearer $PT" -d '{"type":"category","name":"X"}' $B/admin/taxonomy | jget '["error"]')
assert_eq "$TAXDENY" "Not allowed for your role" "non-admin blocked from taxonomy"

FAQ=$(curl -s $B/cms/faq | jget '["title"]')
assert_eq "$FAQ" "Frequently Asked Questions" "public reads CMS page"

curl -s -X PUT $J -H "Authorization: Bearer $AD" -d '{"title":"FAQ","body":"Updated body"}' $B/admin/cms/faq >/dev/null
FAQ2=$(curl -s $B/cms/faq | jget '["body"]')
assert_eq "$FAQ2" "Updated body" "admin edits CMS page"

# ============ Phase 5: encryption at rest, audit trail ============

# The doctor wrote an e-prescription earlier ("Rx test"). API must return plaintext...
RXTEXT=$(curl -s -H "Authorization: Bearer $PT" $B/prescriptions | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['content'])")
assert_eq "$RXTEXT" "Rx test" "prescription decrypts to plaintext via the API"

# ...but the raw database column must be ciphertext (encrypted at rest).
RAW=$("$DIR/.venv/bin/python" -c "
import os
url = os.environ.get('DATABASE_URL')
if url:
    import psycopg
    v = psycopg.connect(url, client_encoding='UTF8').execute('SELECT content FROM prescriptions ORDER BY id DESC LIMIT 1').fetchone()[0]
else:
    import sqlite3
    v = sqlite3.connect(os.environ['EPHARMA_DB']).execute('SELECT content FROM prescriptions ORDER BY id DESC LIMIT 1').fetchone()[0]
print('ENC' if v.startswith('enc:') and 'Rx test' not in v else 'PLAIN')
")
assert_eq "$RAW" "ENC" "prescription is encrypted at rest in the database"

# audit trail records security-relevant actions and is admin-only
AUD=$(curl -s -H "Authorization: Bearer $AD" $B/admin/audit | python3 -c "import sys,json;d=json.load(sys.stdin);print(any(a['action']=='order.placed' for a in d) and any(a['action']=='login' for a in d))")
assert_eq "$AUD" "True" "audit log records login and order events"

PTAUD=$(curl -s -H "Authorization: Bearer $PT" $B/admin/audit | jget '["error"]')
assert_eq "$PTAUD" "Not allowed for your role" "non-admin blocked from the audit log"

# ============ Phase 7: consent, subject rights, retention, key rotation ============

# --- consent is mandatory and recorded ---
NOCONSENT=$(curl -s $J -d '{"role":"patient","name":"NC","email":"nc@test.com","password":"secret1","otp":"1"}' $B/register | jget '["error"][:8]')
assert_eq "$NOCONSENT" "You must" "registration without consent rejected"

CV=$(curl -s -H "Authorization: Bearer $PT" $B/me | jget '["consent_version"]')
assert_eq "$([ "$CV" != "None" ] && echo recorded || echo missing)" "recorded" "consent version stored on the account"

CONSENTLOG=$(curl -s -H "Authorization: Bearer $AD" $B/admin/audit | python3 -c "import sys,json;print(any(a['action']=='consent.granted' for a in json.load(sys.stdin)))")
assert_eq "$CONSENTLOG" "True" "consent recorded in the audit trail"

# --- right of access: export returns the person's own data, decrypted ---
EXPORT=$(curl -s -H "Authorization: Bearer $PT" $B/me/data)
assert_eq "$(echo "$EXPORT" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(all(k in d for k in ("account","orders","prescriptions","appointments")))')" "True" "data export contains all record types"
assert_eq "$(echo "$EXPORT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["prescriptions"][0]["content"])')" "Rx test" "exported prescription is decrypted"
assert_eq "$(echo "$EXPORT" | python3 -c 'import sys,json;print("password_hash" in json.load(sys.stdin)["account"])')" "False" "export never includes the password hash"

EXPDENY=$(curl -s $B/me/data | jget '["error"]')
assert_eq "$EXPDENY" "Please log in" "anonymous cannot export data"

# --- retention purge ---
PURGE=$(curl -s -X POST $J -H "Authorization: Bearer $AD" $B/admin/retention/purge)
assert_eq "$(echo "$PURGE" | python3 -c 'import sys,json;print("otps" in json.load(sys.stdin)["removed"])')" "True" "retention purge reports what it removed"
PURGEDENY=$(curl -s -X POST $J -H "Authorization: Bearer $PT" $B/admin/retention/purge | jget '["error"]')
assert_eq "$PURGEDENY" "Not allowed for your role" "non-admin blocked from retention purge"

# --- right to erasure (run last: it destroys this patient's identity) ---
NOPW=$(curl -s $J -H "Authorization: Bearer $PT" -d '{"password":"wrong"}' $B/me/delete | jget '["error"][:8]')
assert_eq "$NOPW" "Password" "erasure requires password confirmation"

ADMINDEL=$(curl -s $J -H "Authorization: Bearer $AD" -d '{"password":"admin123"}' $B/me/delete | jget '["error"][:13]')
assert_eq "$ADMINDEL" "Administrator" "admin accounts cannot self-erase"

ERASED=$(curl -s $J -H "Authorization: Bearer $PT" -d '{"password":"patient123"}' $B/me/delete | jget '["erased"]')
assert_eq "$ERASED" "True" "account erased on request"

RELOGIN=$(curl -s $J -d '{"email":"priya@gmail.com","password":"patient123"}' $B/login | jget '["error"]')
assert_eq "$RELOGIN" "Invalid email or password" "erased account can no longer log in"

SESSIONDEAD=$(curl -s -H "Authorization: Bearer $PT" $B/me | jget '["error"]')
assert_eq "$SESSIONDEAD" "Please log in" "erasure ends existing sessions"

# the order survives (statutory retention) but no longer identifies anyone
KEPT=$(curl -s -H "Authorization: Bearer $AD" $B/admin/stats | jget '["orders"]')
assert_eq "$KEPT" "1" "order records retained after erasure"
ANON=$(curl -s -H "Authorization: Bearer $AD" "$B/admin/users" | python3 -c "import sys,json;print(any(u['name']=='Erased user' for u in json.load(sys.stdin)))")
assert_eq "$ANON" "True" "erased account is anonymised, not deleted"

echo ""
echo "ALL TESTS PASSED"
