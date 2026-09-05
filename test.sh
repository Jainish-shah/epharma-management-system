#!/bin/bash
# End-to-end API test: fresh throwaway DB, full workflow across all four roles.
#
#   bash test.sh                                        # SQLite (throwaway file)
#   DATABASE_URL=postgresql://user@host/db bash test.sh  # PostgreSQL (the DB is reset first)
#
# Every assertion runs even after one fails, and the failures are listed together at the end —
# fixing them one per run is far slower than seeing them all at once. Exits non-zero if any failed.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
export EPHARMA_DB=$(mktemp -d)/test.db
export PORT=3999
export REFILL_DAYS=0   # refills immediately due, so the materialisation path is testable in one run
# The whole suite runs from one IP and logs in 15 times, which would trip the auth tier. Rate
# limiting stays ENABLED (so the middleware is still in the request path for every assertion below)
# but with headroom; the limits themselves are asserted against a dedicated server at the end.
export RATE_LIMIT=100000
export RATE_LIMIT_AUTH=100000
B="http://localhost:$PORT/api"
J='-H Content-Type:application/json'

# The suite seeds demo data and then erases one of the accounts, so a second run against a database
# that still holds the first run's data fails. SQLite gets a fresh file above; PostgreSQL is a
# long-lived server, so drop its schema here and let the app recreate it on boot.
if [ -n "$DATABASE_URL" ]; then
  "$DIR/.venv/bin/python" - <<'RESET'
import os, psycopg
with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as c:
    c.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
print("PostgreSQL schema reset")
RESET
fi

"$DIR/.venv/bin/python" "$DIR/manage.py" runserver 127.0.0.1:$PORT --noreload >/dev/null 2>&1 &
SERVER_PID=$!
# `wait` inside the redirect suppresses the shell's "Terminated" job notice, which otherwise
# prints after the summary and reads like a failure.
trap '{ kill $SERVER_PID; wait $SERVER_PID; } 2>/dev/null || true; rm -rf "$(dirname "$EPHARMA_DB")"' EXIT
for i in $(seq 1 40); do curl -s "$B/medicines" >/dev/null && break; sleep 0.25; done

jget() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

PASSED=0
FAILURES=()
# Records the outcome and ALWAYS returns 0, so `set -e` does not abort the run on a failed
# assertion. The whole list is printed at the end and the script exits non-zero if any failed.
assert_eq() {
  if [ "$1" = "$2" ]; then
    PASSED=$((PASSED + 1)); echo "ok: $3"
  else
    FAILURES+=("$3 — expected '$2', got '$1'"); echo "FAIL: $3 (expected '$2', got '$1')"
  fi
  return 0
}

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

# Resolve the medicine the suite works with by NAME. Using the literal id 1 meant a change to seed
# order would quietly move these assertions onto a different product — and they would still pass.
MED=$(curl -s "$B/medicines?search=Paracetamol" | jget '[0]["id"]')

# --- patient: login, order, book appointment ---
PT=$(curl -s $J -d '{"email":"priya@gmail.com","password":"patient123"}' $B/login | jget '["token"]')
assert_eq "${#PT}" "48" "patient login returns token"

BAD=$(curl -s $J -d '{"email":"priya@gmail.com","password":"wrong"}' $B/login | jget '["error"]')
assert_eq "$BAD" "Invalid email or password" "wrong password rejected"

NOPAY=$(curl -s $J -H "Authorization: Bearer $PT" \
  -d "{\"items\":[{\"medicine_id\":$MED,\"qty\":1}],\"type\":\"pickup\"}" $B/orders | jget '["error"]')
assert_eq "$NOPAY" "Payment required" "order without payment rejected"

ORDER=$(pay_and_order "$PT" "[{\"medicine_id\":$MED,\"qty\":2}]" '{"type":"delivery","address":"Test Lane"}')
assert_eq "$(echo "$ORDER" | jget '["status"]')" "pending" "order placed after payment verified"
OID=$(echo "$ORDER" | jget '["id"]')

STOCK=$(curl -s "$B/medicines?search=Paracetamol" | jget '[0]["stock"]')
assert_eq "$STOCK" "198" "stock decremented after order"

OVERSELL=$(curl -s $J -H "Authorization: Bearer $PT" \
  -d "{\"items\":[{\"medicine_id\":$MED,\"qty\":9999}]}" $B/payments/create | jget '["error"][:4]')
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
# Look the pending doctor up rather than assuming a seed id — a change to seed order would
# otherwise point this assertion at a different account and still pass.
PENDING_DR=$(curl -s -H "Authorization: Bearer $AD" $B/admin/users \
  | python3 -c "import sys,json;print(next(u['id'] for u in json.load(sys.stdin) if u['role']=='doctor' and u['status']=='pending'))")
S=$(curl -s -X PATCH $J -H "Authorization: Bearer $AD" -d '{"status":"approved"}' $B/admin/users/$PENDING_DR | jget '["status"]')
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

# --- Phase 8: GST invoice raised with the order ---
INV=$(curl -s -H "Authorization: Bearer $PT" $B/orders/$OID/invoice)
# the expected financial year, worked out independently of the code under test
FY=$(python3 -c "
from datetime import datetime, timezone
d = datetime.now(timezone.utc); y = d.year if d.month >= 4 else d.year - 1
print(f'{y}-{str(y + 1)[-2:]}')")
assert_eq "$(echo "$INV" | jget '["invoice_no"]')" "INV/$FY/0001" "invoice numbered per pharmacy per financial year"
# 2 x Paracetamol at MRP 30 = 60 inclusive of 5% GST -> taxable 57.14, tax 2.86, total unchanged
assert_eq "$(echo "$INV" | jget '["taxable_total"]')" "57.14" "taxable value extracted from GST-inclusive MRP"
assert_eq "$(echo "$INV" | jget '["tax_total"]')" "2.86" "GST amount extracted, not added on top"
assert_eq "$(echo "$INV" | jget '["grand_total"]')" "60" "invoice total equals what the patient paid"
assert_eq "$(echo "$INV" | jget '["tax_summary"][0]["cgst"]')" "1.43" "tax split half CGST half SGST"
DENIED=$(curl -s -H "Authorization: Bearer $DR" $B/orders/$OID/invoice | jget '["error"]')
assert_eq "$DENIED" "Order not found" "unrelated party cannot read an invoice"

# An issued invoice is a historical document: moving the product to another GST slab must not
# retrospectively change the tax already charged to the customer.
curl -s -X PATCH $J -H "Authorization: Bearer $PH" -d '{"gst_rate":12}' $B/medicines/$MED >/dev/null
REPRICED=$(curl -s -H "Authorization: Bearer $PT" $B/orders/$OID/invoice | jget '["lines"][0]["gst_rate"]')
assert_eq "$REPRICED" "5" "issued invoice keeps the rate charged, not the product's new rate"
curl -s -X PATCH $J -H "Authorization: Bearer $PH" -d '{"gst_rate":5}' $B/medicines/$MED >/dev/null

# --- Phase 8: nothing ships without a carrier ---
NOCARRIER=$(curl -s -X PATCH -H "Authorization: Bearer $PH" $B/orders/$OID | jget '["error"][:6]')
assert_eq "$NOCARRIER" "Assign" "delivery order cannot be shipped unassigned"

NOTRACK=$(curl -s -X POST $J -H "Authorization: Bearer $PH" \
  -d '{"delivery_mode":"partner","courier_name":"Delhivery"}' $B/orders/$OID/delivery | jget '["error"][:8]')
assert_eq "$NOTRACK" "Courier " "partner courier requires a tracking number"

ASSIGN=$(curl -s -X POST $J -H "Authorization: Bearer $PH" \
  -d '{"delivery_mode":"own","courier_name":"Suresh Kadam","rider_phone":"9876500030"}' $B/orders/$OID/delivery)
assert_eq "$(echo "$ASSIGN" | jget '["delivery_mode"]')" "own" "order assigned to own rider"
assert_eq "$(echo "$ASSIGN" | jget '["courier_name"]')" "Suresh Kadam" "rider recorded on the order"

S=$(curl -s -X PATCH -H "Authorization: Bearer $PH" $B/orders/$OID | jget '["status"]')
assert_eq "$S" "shipped" "assigned order ships"

# --- Phase 8: stock ledger explains every movement ---
LEDGER=$(curl -s -H "Authorization: Bearer $PH" $B/medicines/$MED/stock)
assert_eq "$(echo "$LEDGER" | jget '[0]["reason"]')" "sale" "the order wrote a sale movement"
assert_eq "$(echo "$LEDGER" | jget '[0]["delta"]')" "-2" "sale movement records the units sold"
assert_eq "$(echo "$LEDGER" | jget '[0]["balance"]')" "198" "movement records the balance after it"
assert_eq "$(echo "$LEDGER" | jget '[-1]["reason"]')" "opening" "opening stock is itself a movement"

RESTOCK=$(curl -s -X POST $J -H "Authorization: Bearer $PH" -d '{"delta":50,"reason":"restock"}' $B/medicines/$MED/stock)
assert_eq "$(echo "$RESTOCK" | jget '["stock"]')" "248" "restock raises the stock level"

TOOMANY=$(curl -s -X POST $J -H "Authorization: Bearer $PH" -d '{"delta":-9999,"reason":"expiry"}' $B/medicines/$MED/stock | jget '["error"][:4]')
assert_eq "$TOOMANY" "Only" "cannot write off more units than are on the shelf"

BADREASON=$(curl -s -X POST $J -H "Authorization: Bearer $PH" -d '{"delta":5,"reason":"whatever"}' $B/medicines/$MED/stock | jget '["error"]')
assert_eq "$BADREASON" "Unknown reason" "stock movements need a known reason"

DENIED=$(curl -s -H "Authorization: Bearer $PT" $B/medicines/$MED/stock | jget '["error"]')
assert_eq "$DENIED" "Not allowed for your role" "patients cannot read the stock ledger"

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

# --- endpoints that had no coverage at all ---
# /logout is the important one: a session that outlives its logout is a security defect, and
# nothing was asserting that it does not.
LOGOUT_TOK=$(curl -s $J -d '{"email":"store@medplus.com","password":"pharma123"}' $B/login | jget '["token"]')
assert_eq "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $LOGOUT_TOK" $B/my-medicines)" "200" "fresh token works before logout"
curl -s -X POST -H "Authorization: Bearer $LOGOUT_TOK" $B/logout >/dev/null
assert_eq "$(curl -s -H "Authorization: Bearer $LOGOUT_TOK" $B/my-medicines | jget '["error"]')" "Please log in" "logout revokes the token immediately"
assert_eq "$(curl -s -H "Authorization: Bearer $PH" $B/my-medicines | python3 -c "import sys,json;print(len(json.load(sys.stdin))>0)")" "True" "logging one session out does not affect another"

# /my-medicines — a pharmacy sees only its own stock, never a competitor's
MINE=$(curl -s -H "Authorization: Bearer $PH" $B/my-medicines)
assert_eq "$(echo "$MINE" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")" "12" "pharmacy sees its own inventory"
assert_eq "$(curl -s -H "Authorization: Bearer $PT" $B/my-medicines | jget '["error"]')" "Not allowed for your role" "patients cannot read pharmacy inventory"

# /doctors — public listing must expose approved doctors only, and never a password hash
DOCS=$(curl -s $B/doctors)
assert_eq "$(echo "$DOCS" | python3 -c "import sys,json;print(all('password_hash' not in d for d in json.load(sys.stdin)))")" "True" "public doctor listing leaks no password hash"
assert_eq "$(curl -s "$B/doctors?search=Cardio" | jget '[0]["specialization"]')" "Cardiology" "doctors are searchable by specialty"

# /prescriptions/upload — the patient's own upload path (distinct from a doctor's e-prescription)
UP=$(curl -s $J -H "Authorization: Bearer $PT" -d '{"content":"data:image/png;base64,iVBORw0KGgo="}' $B/prescriptions/upload)
assert_eq "$(echo "$UP" | jget '["kind"]')" "uploaded" "patient can upload a prescription"
assert_eq "$(curl -s $J -H "Authorization: Bearer $PT" -d '{"content":""}' $B/prescriptions/upload | jget '["error"]')" "No file received" "an empty prescription upload is rejected"

# /notifications/read — the unread badge must actually clear
curl -s -X POST -H "Authorization: Bearer $PT" $B/notifications/read >/dev/null
assert_eq "$(curl -s -H "Authorization: Bearer $PT" $B/notifications | python3 -c "import sys,json;print(sum(1 for n in json.load(sys.stdin) if not n['read']))")" "0" "marking notifications read clears every unread one"

# /earnings — a doctor's fee times completed consultations
EARN=$(curl -s -H "Authorization: Bearer $DR" $B/earnings)
assert_eq "$(echo "$EARN" | jget '["consultations"]')" "1" "earnings count completed consultations"
assert_eq "$(echo "$EARN" | jget '["total"]')" "600" "earnings equal fee x completed consultations"
assert_eq "$(curl -s -H "Authorization: Bearer $PT" $B/earnings | jget '["error"]')" "Not allowed for your role" "patients cannot read doctor earnings"

# --- invoice numbers stay unique and gap-free under concurrent checkout ---
# The serial is reserved inside the order transaction under a row lock. This guards that: without
# it, two simultaneous checkouts at one pharmacy could be handed the same tax-invoice number.
CC_PORT=3996
CC_DB=$(mktemp -d)/cc.db
EPHARMA_DB=$CC_DB PORT=$CC_PORT RATE_LIMIT=100000 RATE_LIMIT_AUTH=100000 \
  "$DIR/.venv/bin/python" "$DIR/manage.py" runserver 127.0.0.1:$CC_PORT --noreload >/dev/null 2>&1 &
CC_PID=$!
CB="http://localhost:$CC_PORT/api"
for i in $(seq 1 40); do curl -s "$CB/medicines" >/dev/null && break; sleep 0.25; done

SERIALS=$("$DIR/.venv/bin/python" - "$CB" <<'CONC'
import json, sys, urllib.request, concurrent.futures as cf
B = sys.argv[1]

def post(path, body, tok=None):
    req = urllib.request.Request(B + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json",
                                          **({"Authorization": "Bearer " + tok} if tok else {})})
    return json.load(urllib.request.urlopen(req))

tok = post("/login", {"email": "priya@gmail.com", "password": "patient123"})["token"]
med = json.load(urllib.request.urlopen(B + "/medicines?search=Paracetamol"))[0]["id"]

def checkout(_):
    items = [{"medicine_id": med, "qty": 1}]
    pay = post("/payments/create", {"items": items}, tok)
    return post("/orders", {"items": items, "type": "pickup",
                            "payment": pay["demoCheckout"]}, tok)["invoice_no"]

with cf.ThreadPoolExecutor(8) as ex:
    nos = list(ex.map(checkout, range(8)))
seqs = sorted(int(n.rsplit("/", 1)[1]) for n in nos)
print(f"{len(set(nos))} {seqs == list(range(1, 9))}")
CONC
)
assert_eq "$(echo "$SERIALS" | cut -d' ' -f1)" "8" "8 concurrent checkouts get 8 distinct invoice numbers"
assert_eq "$(echo "$SERIALS" | cut -d' ' -f2)" "True" "the concurrent invoice series has no gaps"
{ kill $CC_PID; wait $CC_PID; } 2>/dev/null || true
rm -rf "$(dirname "$CC_DB")"

# --- rate limiting: excess load is shed with 429 (own server, tight limits) ---
RL_PORT=3997
RATE_LIMIT=1000 RATE_LIMIT_AUTH=3 EPHARMA_DB=$(mktemp -d)/rl.db PORT=$RL_PORT \
  "$DIR/.venv/bin/python" "$DIR/manage.py" runserver 127.0.0.1:$RL_PORT --noreload >/dev/null 2>&1 &
RL_PID=$!
RB="http://localhost:$RL_PORT/api"
for i in $(seq 1 40); do curl -s "$RB/health" >/dev/null && break; sleep 0.25; done

# the auth tier allows 3 per window; the 4th must be refused
for i in 1 2 3; do curl -s -o /dev/null $J -d '{"email":"priya@gmail.com","password":"patient123"}' $RB/login; done
RL_CODE=$(curl -s -o /dev/null -w "%{http_code}" $J -d '{"email":"priya@gmail.com","password":"patient123"}' $RB/login)
assert_eq "$RL_CODE" "429" "excess auth requests are refused with 429"

RL_HEAD=$(curl -si $J -d '{"email":"priya@gmail.com","password":"patient123"}' $RB/login)
assert_eq "$(echo "$RL_HEAD" | grep -ci '^Retry-After:')" "1" "429 carries a Retry-After header"
assert_eq "$(echo "$RL_HEAD" | grep -ci '^RateLimit-Limit:')" "1" "rate-limit headers are advertised"
assert_eq "$(echo "$RL_HEAD" | tail -1 | jget '["error"][:8]')" "Too many" "429 body is JSON, not an HTML error page"

# a throttled health check would make a load balancer drop a healthy instance
for i in $(seq 1 12); do curl -s -o /dev/null "$RB/health"; done
assert_eq "$(curl -s -o /dev/null -w '%{http_code}' "$RB/health")" "200" "health checks are never rate limited"

# the default tier is separate: exhausting auth must not lock everyone out of the catalog
assert_eq "$(curl -s -o /dev/null -w '%{http_code}' "$RB/medicines")" "200" "auth throttling does not block the public catalog"

{ kill $RL_PID; wait $RL_PID; } 2>/dev/null || true

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
echo "--------------------------------------------------------------"
if [ ${#FAILURES[@]} -eq 0 ]; then
  echo "ALL TESTS PASSED  ($PASSED assertions)"
else
  echo "$PASSED passed, ${#FAILURES[@]} FAILED:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
