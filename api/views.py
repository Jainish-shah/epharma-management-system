"""HTTP endpoints — the whole REST API lives here (Python/Django port of the old server.js).

How a request flows:
    browser  ->  epharma_site/urls.py  ->  api/urls.py  ->  a view function below  ->  JsonResponse

Each view is a plain function that takes the Django `request`, does its work with the tiny
`db` helper (raw SQL), and returns JSON via `J(...)`. There is no ORM and no DRF — the SQL and the
JSON shapes are written out explicitly so the frontend contract is easy to follow.

Four conventions you'll see everywhere:
  * `@api`                 — a PUBLIC view. Parses the JSON body, turns any crash into JSON.
  * `@auth("admin")`       — a PROTECTED view. Rejects the request unless the caller is signed in
                             with one of the listed roles, then sets `request.user`. The access rule
                             sits on the line above the function, so it is impossible to forget and
                             trivial to audit.
  * `role_scope(user, {...})` — builds the WHERE clause that limits a listing to what a role may see.
  * `price_cart(items, reserve=)` — the single definition of the cart rules, used by both checkout steps.

`require_auth()` is still available for the few endpoints whose access rule depends on the HTTP
method (GET /api/medicines is public; POST is pharmacy-only).
"""
import json
import mimetypes
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from django.http import JsonResponse, HttpResponse
from django.views.decorators.csrf import csrf_exempt

from . import db, payments, events, crypto


def _now():
    """Current UTC time as a sortable 'YYYY-MM-DD HH:MM:SS' string (portable across SQLite/Postgres)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _plus_days(days):
    return (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")

# ---- configuration (all overridable by environment variables) ----
REFILL_DAYS = int(os.environ.get("REFILL_DAYS") or 30)          # days after an order before a refill reminder is due
NOTIFY_CHANNELS = (os.environ.get("NOTIFY_CHANNELS") or "log").split(",")  # where notifications are "delivered" (log/email/sms)
CONSULT_SECRET = os.environ.get("CONSULT_SECRET") or "epharma-consult-secret"  # salts the Jitsi video room name
NEXT_STATUS = {"pending": "preparing", "preparing": None, "shipped": "delivered", "ready": "picked_up"}  # order pipeline
PUBLIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "public")  # the SPA files

TOPICS = events.TOPICS


def J(data, status=200):
    """Return JSON. Also normalises whole floats (60.0 -> 60) so output matches the old JS backend."""
    data = _num(data)
    return JsonResponse(data, status=status, safe=not isinstance(data, list))


def _num(x):
    # Normalise numbers so SQLite and Postgres produce identical JSON:
    #   - Postgres SUM/ROUND return Decimal -> make it a float
    #   - both: an integral float/decimal (60.0) prints as "60" (matches the old JS backend)
    if isinstance(x, bool):
        return x
    if isinstance(x, Decimal):
        x = float(x)
    if isinstance(x, float) and x.is_integer():
        return int(x)
    if isinstance(x, dict):
        return {k: _num(v) for k, v in x.items()}
    if isinstance(x, list):
        return [_num(v) for v in x]
    return x


# ---------- validation helpers (used to reject bad input at the boundary) ----------
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_PHONE_RE = re.compile(r"^[0-9+\-\s]{7,15}$")


def is_email(s):
    return isinstance(s, str) and bool(_EMAIL_RE.match(s))


def is_phone(s):
    # phone is optional: empty/None is allowed, otherwise it must look like a phone number
    return s is None or s == "" or (isinstance(s, str) and bool(_PHONE_RE.match(s)))


def non_empty(s):
    return isinstance(s, str) and len(s.strip()) > 0


def non_neg_num(n):
    if n is None or n == "":
        return False
    try:
        return float(n) >= 0
    except (TypeError, ValueError):
        return False


def gen_otp():
    """A random 6-digit code (100000–999999) for registration verification."""
    return str(secrets.randbelow(900000) + 100000)


# ---------- notifications + event consumers ----------
# Instead of writing to the DB directly, we PUBLISH a notification event. Several independent
# "consumers" (registered just below) react to it: one saves it, another "delivers" it by email/SMS.
# This is the event-driven design — producers don't know or care who consumes.
def notify(user_id, message):
    events.publish(TOPICS["NOTIFICATIONS"], {"userId": user_id, "message": message})


def notify_admins(message):
    for a in db.query("SELECT id FROM users WHERE role = 'admin'"):
        notify(a["id"], message)


# Consumer 1 — persistence: save every notification event as a row.
events.subscribe(TOPICS["NOTIFICATIONS"], lambda e: db.run(
    "INSERT INTO notifications (user_id, message) VALUES (?, ?)", (e["userId"], e["message"])))


# Consumer — payments: when a payment succeeds, send the patient a receipt notification.
def _on_payment(e):
    print(f"[payments] order #{e['orderId']} paid: ₹{e['amount'] / 100:.2f}")
    notify(e["patientId"], f"Payment received: ₹{e['amount'] / 100:.2f} for order #{e['orderId']}")


events.subscribe(TOPICS["PAYMENTS"], _on_payment)

# Consumer — orders/analytics: a second consumer on the orders topic (shows fan-out; here just logs).
events.subscribe(TOPICS["ORDERS"], lambda e: print(
    f"[orders] order #{e['orderId']} placed with pharmacy {e['pharmacyId']} (₹{e['total']:.2f})"))


# Consumer 2 on notifications — delivery gateway: "send" the message by email/SMS.
# Mock = a log line. Set NOTIFY_CHANNELS=email,sms and drop in Twilio/SES here to go live.
def _deliver(e):
    u = db.get("SELECT email, phone FROM users WHERE id = ?", (e["userId"],))
    if not u:
        return
    if any(c in ("email", "log") for c in NOTIFY_CHANNELS):
        print(f"[email -> {u['email']}] {e['message']}")
    if u["phone"] and any(c in ("sms", "log") for c in NOTIFY_CHANNELS):
        print(f"[sms -> {u['phone']}] {e['message']}")


events.subscribe(TOPICS["NOTIFICATIONS"], _deliver)


def run_due_refills(patient_id):
    """Turn any refill reminders that have come due into real notifications (checked when the
    patient opens their notifications, so no background scheduler is needed for the demo)."""
    due = db.query("SELECT * FROM refill_reminders WHERE patient_id = ? AND notified = 0 AND due_date <= ?",
                   (patient_id, _now()))
    for r in due:
        notify(patient_id, f"Refill reminder: it may be time to reorder {r['medicine_name']}")
        db.run("UPDATE refill_reminders SET notified = 1 WHERE id = ?", (r["id"],))


# ---------- request plumbing ----------
def body(request):
    """Parse the JSON request body into a dict ({} if empty)."""
    if not request.body:
        return {}
    return json.loads(request.body)  # raises json.JSONDecodeError -> handled by @api below


class Forbidden(Exception):
    """Raised when the caller's role may not access a resource at all (turned into a 403 by @api)."""


def api(fn):
    """Decorator for PUBLIC views: parse the JSON body up front, and convert a bad body or an
    unexpected exception into a clean JSON error (instead of Django's HTML error page)."""
    @csrf_exempt
    def wrapper(request, *a, **kw):
        try:
            request.data = body(request)
        except json.JSONDecodeError:
            return J({"error": "Malformed JSON in request body"}, 400)
        try:
            return fn(request, *a, **kw)
        except Forbidden:
            return J({"error": "Not allowed for your role"}, 403)
        except Exception as e:  # noqa: BLE001
            print("ERROR", repr(e))
            return J({"error": "Internal server error"}, 500)
    wrapper.__name__ = fn.__name__
    return wrapper


def auth(*roles):
    """Decorator for PROTECTED views — use instead of @api. Rejects the request unless the caller
    is logged in (and, when roles are given, holds one of them), then sets `request.user`:

        @auth("admin")                  # admins only
        def admin_stats(request): ...   # request.user is the signed-in admin

        @auth()                         # any signed-in user
        @auth("patient", "doctor")      # either role

    Making the requirement part of the signature means every protected endpoint states its own
    access rule on the line above it — one place to audit, and no way to forget the check.
    """
    def decorate(fn):
        @api
        def wrapper(request, *a, **kw):
            user, err = require_auth(request, *roles)
            if err:
                return err
            request.user = user
            return fn(request, *a, **kw)
        wrapper.__name__ = fn.__name__
        return wrapper
    return decorate


def require_auth(request, *roles):
    """Resolve the caller from their `Authorization: Bearer <token>` header.
    Returns (user_dict, None) when allowed, or (None, error_response) to return immediately.
    Prefer the @auth decorator; this is for the few views whose access rule depends on the HTTP
    method (e.g. GET /api/medicines is public but POST is pharmacy-only)."""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    user = db.get("SELECT u.* FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?", (token,))
    if not user:
        return None, J({"error": "Please log in"}, 401)
    if roles and user["role"] not in roles:
        return None, J({"error": "Not allowed for your role"}, 403)
    return user, None


def role_scope(user, columns):
    """Build the WHERE clause that limits a listing to what this role may see.

    `columns` maps each permitted role to the column that must match the caller's id; map a role to
    None to let it see everything. Roles absent from the map are refused.

        role_scope(user, {"patient": "o.patient_id", "pharmacy": "o.pharmacy_id", "admin": None})

    Returns (where_sql, params). Raises Forbidden for a role that has no entry — the caller lets it
    propagate and @api turns it into the 403 response.
    """
    if user["role"] not in columns:
        raise Forbidden()
    column = columns[user["role"]]
    if column is None:                      # e.g. admin sees every row
        return "", ()
    return f"WHERE {column} = ?", (user["id"],)


# ==================== public config / taxonomy / cms ====================
@api
def config(request):
    """GET /api/config — public. Tells the frontend which payment provider is active."""
    return J({"paymentProvider": payments.provider, "mock": payments.IS_MOCK})


@api
def health(request):
    """GET /api/health — public. Liveness/readiness probe for load balancers and deploys.
    Returns 200 only if the database actually answers a query; 503 otherwise."""
    try:
        db.get("SELECT 1 AS ok")
        return J({
            "status": "ok",
            "database": "postgresql" if db.IS_PG else "sqlite",
            "paymentProvider": payments.provider,
            "events": "kafka" if events.kafka_ready() else "in-process",
        })
    except Exception as e:  # noqa: BLE001 — a failing probe must report, not crash
        return J({"status": "unavailable", "error": str(e)}, 503)


@api
def taxonomy(request):
    """GET /api/taxonomy?type=category|specialty — public. Admin-managed lists used as form suggestions."""
    t = request.GET.get("type")
    rows = (db.query("SELECT * FROM taxonomy WHERE type = ? ORDER BY name", (t,)) if t
            else db.query("SELECT * FROM taxonomy ORDER BY type, name"))
    return J(rows)


@api
def cms_list(request):
    """GET /api/cms — public. List of editable content pages (FAQ / Terms / Privacy)."""
    return J(db.query("SELECT slug, title FROM cms_pages ORDER BY slug"))


@api
def cms_page(request, slug):
    """GET /api/cms/<slug> — public. Full content of one CMS page."""
    page = db.get("SELECT * FROM cms_pages WHERE slug = ?", (slug,))
    return J(page) if page else J({"error": "Page not found"}, 404)


# ==================== auth & registration ====================
@api
def send_otp(request):
    """POST /api/register/send-otp — public. Step 1 of patient sign-up: issue a 6-digit code.
    Demo returns the code in the response (and logs it); a real build would SMS/email it instead."""
    email = request.data.get("email")
    if not is_email(email):
        return J({"error": "A valid email is required"}, 400)
    if db.get("SELECT id FROM users WHERE email = ?", (email,)):
        return J({"error": "Email already registered"}, 400)
    code = gen_otp()
    # upsert: one live code per email (replaces any previous one)
    db.run("INSERT INTO otps (email, code, created_at) VALUES (?, ?, CURRENT_TIMESTAMP) "
           "ON CONFLICT(email) DO UPDATE SET code = excluded.code, created_at = excluded.created_at", (email, code))
    print(f"[OTP] {email} -> {code}")
    return J({"otpSent": True, "devOtp": None if os.environ.get("NODE_ENV") == "production" else code})


@api
def register(request):
    """POST /api/register — public. Create a patient/doctor/pharmacy account.
    Patients must pass a matching OTP; doctors & pharmacies start 'pending' for admin approval."""
    b = request.data
    # --- validate every field before touching the database ---
    if b.get("role") not in ("patient", "doctor", "pharmacy"):
        return J({"error": "Invalid role"}, 400)
    if not non_empty(b.get("name")):
        return J({"error": "Name is required"}, 400)
    if not is_email(b.get("email")):
        return J({"error": "A valid email is required"}, 400)
    if not non_empty(b.get("password")) or len(b["password"]) < 6:
        return J({"error": "Password must be at least 6 characters"}, 400)
    if not is_phone(b.get("phone")):
        return J({"error": "Phone number looks invalid"}, 400)
    if b["role"] == "doctor" and (not non_empty(b.get("qualification")) or not non_empty(b.get("specialization"))):
        return J({"error": "Doctors must provide qualification and specialization"}, 400)
    if b["role"] == "pharmacy" and (not non_empty(b.get("store_name")) or not non_empty(b.get("license_no"))):
        return J({"error": "Pharmacies must provide store name and drug license number"}, 400)
    if b.get("fee") not in (None, "") and not non_neg_num(b.get("fee")):
        return J({"error": "Fee must be a non-negative number"}, 400)
    if db.get("SELECT id FROM users WHERE email = ?", (b["email"],)):
        return J({"error": "Email already registered"}, 400)

    # --- patients: verify the OTP issued by send-otp ---
    if b["role"] == "patient":
        row = db.get("SELECT code FROM otps WHERE email = ?", (b["email"],))
        if not row or row["code"] != str(b.get("otp") or ""):
            return J({"error": "Invalid or missing OTP — please verify your email/mobile first"}, 400)

    status = "approved" if b["role"] == "patient" else "pending"  # providers need admin approval
    # verification files, if any — encrypted at rest
    documents = crypto.encrypt(json.dumps(b["documents"])) if isinstance(b.get("documents"), dict) else None
    uid = db.run(
        "INSERT INTO users (role, name, email, phone, password_hash, status, specialization, qualification, fee, "
        "availability, store_name, license_no, gstin, address, documents) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (b["role"], b["name"].strip(), b["email"], b.get("phone") or None, db.hash_password(b["password"]), status,
         b.get("specialization") or None, b.get("qualification") or None, b.get("fee") or None,
         b.get("availability") or None, b.get("store_name") or None, b.get("license_no") or None,
         b.get("gstin") or None, b.get("address") or None, documents))
    db.run("DELETE FROM otps WHERE email = ?", (b["email"],))  # OTP is single-use
    if status == "pending":
        notify_admins(f"New {b['role']} registration awaiting approval: {b['name']}")
    user = db.get("SELECT * FROM users WHERE id = ?", (uid,))
    db.audit(user, "register", user["role"])
    # hand back a session token so the new user is logged in immediately
    return J({"token": db.issue_token(user["id"]), "user": db.public_user(user)})


@auth("doctor", "pharmacy")
def me_documents(request):
    """POST /api/me/documents — doctor/pharmacy. Upload/replace verification documents for review."""
    user = request.user
    docs = request.data.get("documents")
    if not isinstance(docs, dict) or not docs:
        return J({"error": "No documents provided"}, 400)
    db.run("UPDATE users SET documents = ? WHERE id = ?", (crypto.encrypt(json.dumps(docs)), user["id"]))
    db.audit(user, "documents.upload")
    notify_admins(f"{user['name']} ({user['role']}) uploaded verification documents")
    return J({"ok": True})


@api
def login(request):
    """POST /api/login — public. Verify email+password, return a session token."""
    email = request.data.get("email") or ""
    user = db.get("SELECT * FROM users WHERE email = ?", (email,))
    if not user or not db.verify_password(request.data.get("password") or "", user["password_hash"]):
        db.audit(None, "login.failed", email)  # audit failed attempts (security signal)
        return J({"error": "Invalid email or password"}, 401)  # same message for both cases (don't reveal which)
    db.audit(user, "login")
    return J({"token": db.issue_token(user["id"]), "user": db.public_user(user)})


@auth()
def logout(request):
    """POST /api/logout — any user. Delete the current token so it can't be reused."""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    db.run("DELETE FROM tokens WHERE token = ?", (token,))
    return J({"ok": True})


@auth()
def me(request):
    """GET /api/me — any user (return profile).  PATCH /api/me — update allowed profile fields."""
    user = request.user
    if request.method == "PATCH":
        allowed = ["name", "phone", "address", "availability", "fee", "specialization", "qualification"]
        for key in allowed:  # only whitelisted columns can be changed
            if key in request.data:
                db.run(f"UPDATE users SET {key} = ? WHERE id = ?", (request.data[key], user["id"]))
        user = db.get("SELECT * FROM users WHERE id = ?", (user["id"],))
    return J(db.public_user(user))


# ==================== catalog & pharmacy inventory ====================
@api
def medicines(request):
    """GET /api/medicines?search= — public catalog (approved pharmacies only).
    POST /api/medicines — pharmacy adds a medicine to their own inventory."""
    if request.method == "POST":
        user, err = require_auth(request, "pharmacy")
        if err:
            return err
        b = request.data
        if not non_empty(b.get("name")) or not non_empty(b.get("category")):
            return J({"error": "Name and category are required"}, 400)
        if not non_neg_num(b.get("price")):
            return J({"error": "Price must be a non-negative number"}, 400)
        if b.get("stock") not in (None, "") and not non_neg_num(b.get("stock")):
            return J({"error": "Stock must be a non-negative number"}, 400)
        mid = db.run("INSERT INTO medicines (pharmacy_id, name, category, price, stock) VALUES (?, ?, ?, ?, ?)",
                     (user["id"], b["name"], b["category"], float(b["price"]), int(float(b.get("stock") or 0))))
        return J(db.get("SELECT * FROM medicines WHERE id = ?", (mid,)))
    search = f"%{request.GET.get('search', '')}%"  # LIKE pattern; empty search matches everything
    return J(db.query(
        "SELECT m.*, u.store_name FROM medicines m JOIN users u ON u.id = m.pharmacy_id AND u.status = 'approved' "
        "WHERE m.name LIKE ? OR m.category LIKE ? ORDER BY m.name", (search, search)))


@api
def doctors(request):
    """GET /api/doctors?search= — public. Approved doctors, searchable by name or specialty."""
    search = f"%{request.GET.get('search', '')}%"
    return J(db.query(
        "SELECT id, name, specialization, qualification, fee, availability FROM users "
        "WHERE role = 'doctor' AND status = 'approved' AND (name LIKE ? OR specialization LIKE ?) ORDER BY name",
        (search, search)))


@auth("pharmacy")
def medicine_detail(request, id):
    """PATCH /api/medicines/<id> — edit.  DELETE /api/medicines/<id> — remove.
    Pharmacy only, and only for medicines they own (the WHERE clause enforces ownership)."""
    user = request.user
    med = db.get("SELECT * FROM medicines WHERE id = ? AND pharmacy_id = ?", (id, user["id"]))
    if not med:
        return J({"error": "Medicine not found"}, 404)
    if request.method == "DELETE":
        db.run("DELETE FROM medicines WHERE id = ? AND pharmacy_id = ?", (id, user["id"]))
        return J({"ok": True})
    m = {**med, **request.data}  # start from the existing row, overlay any provided fields
    db.run("UPDATE medicines SET name = ?, category = ?, price = ?, stock = ? WHERE id = ?",
           (m["name"], m["category"], float(m["price"]), int(float(m["stock"])), med["id"]))
    return J(db.get("SELECT * FROM medicines WHERE id = ?", (med["id"],)))


@auth("pharmacy")
def my_medicines(request):
    """GET /api/my-medicines — pharmacy. The signed-in pharmacy's own inventory."""
    user = request.user
    return J(db.query("SELECT * FROM medicines WHERE pharmacy_id = ? ORDER BY name", (user["id"],)))


# ==================== payments (checkout step 1) ====================
def price_cart(items, reserve=False):
    """The one place the cart rules live: every item exists, all items come from a single pharmacy,
    and enough stock is on hand. Returns (total, pharmacy_id, [(medicine, qty), ...]) and raises
    ValueError with a user-facing message on any problem.

    `reserve=False` prices the cart without touching stock — used to size the payment.
    `reserve=True` also deducts the stock — used when the paid order is actually placed.

    Both checkout steps go through this function so the rule that priced the payment is the same
    rule that fills the order; they cannot drift apart.
    """
    if not isinstance(items, list) or not items:
        raise ValueError("Cart is empty")
    total, pharmacy_id, lines = 0, None, []
    for it in items:
        med = db.get("SELECT * FROM medicines WHERE id = ?", (it.get("medicine_id"),))
        if not med:
            raise ValueError("Medicine not found")
        if pharmacy_id and pharmacy_id != med["pharmacy_id"]:
            raise ValueError("All items must be from one pharmacy")  # one order = one pharmacy
        pharmacy_id = med["pharmacy_id"]
        qty = max(1, int(it.get("qty") or 1))
        if med["stock"] < qty:
            raise ValueError(f"Only {med['stock']} left of {med['name']}")
        if reserve:
            # Taking the stock is part of the same pass, so the quantity that was checked is exactly
            # the quantity deducted. Callers run this inside a transaction, so a later failure
            # (e.g. the amount-tamper check) rolls the deduction back.
            db.run("UPDATE medicines SET stock = stock - ? WHERE id = ?", (qty, med["id"]))
        total += med["price"] * qty
        lines.append((med, qty))
    return total, pharmacy_id, lines


@auth("patient")
def payments_create(request):
    """POST /api/payments/create — patient. Create a payment intent sized to the cart.
    Returns the provider order id; on the mock gateway also returns `demoCheckout` (the signed
    fields a real Stripe/Razorpay widget would hand back) so the demo can complete a payment."""
    user = request.user
    try:
        total, _, _ = price_cart(request.data.get("items"))
    except ValueError as e:
        return J({"error": str(e)}, 400)
    amount = round(total * 100)  # provider amounts are in the smallest unit (paise)
    intent = payments.create_intent(amount)
    db.run("INSERT INTO payments (provider_order_id, patient_id, amount) VALUES (?, ?, ?)",
           (intent["id"], user["id"], amount))
    return J({"provider": payments.provider, "providerOrderId": intent["id"], "amount": amount,
              "currency": intent["currency"], "key": intent["key"], "clientSecret": intent.get("clientSecret"),
              "demoCheckout": payments.mock_checkout(intent["id"]) if payments.IS_MOCK else None})


# ==================== orders ====================
@api
def orders(request):
    """GET /api/orders — list orders scoped to the caller's role (patient sees theirs, pharmacy
    theirs, admin all).  POST /api/orders — place a paid order (see _create_order)."""
    if request.method == "POST":
        return _create_order(request)
    user, err = require_auth(request)
    if err:
        return err
    # patients see their own orders, pharmacies the ones placed with them, admins everything
    where, params = role_scope(user, {"patient": "o.patient_id", "pharmacy": "o.pharmacy_id", "admin": None})
    rows = db.query(
        "SELECT o.*, p.name AS patient_name, ph.store_name FROM orders o "
        "JOIN users p ON p.id = o.patient_id JOIN users ph ON ph.id = o.pharmacy_id "
        f"{where} ORDER BY o.id DESC", params)
    for o in rows:  # attach line items + any prescription to each order
        o["items"] = db.query("SELECT * FROM order_items WHERE order_id = ?", (o["id"],))
        rx = db.get("SELECT content FROM prescriptions WHERE id = ?", (o["prescription_id"],)) if o["prescription_id"] else None
        o["prescription"] = crypto.decrypt(rx["content"]) if rx else None
    return J(rows)


def _create_order(request):
    """Place an order — the app's most careful path. Steps:
       1. verify the payment (must exist, be unused, and pass signature verification),
       2. inside a DB transaction: re-check stock, decrement it, and create the order + items,
       3. confirm the paid amount equals the freshly re-computed total (anti-tamper),
       4. schedule refill reminders and emit order/payment events.
    If anything fails the transaction rolls back, so stock is never left half-decremented."""
    user, err = require_auth(request, "patient")
    if err:
        return err
    b = request.data
    items, otype, address, prescription, payment = (
        b.get("items"), b.get("type"), b.get("address"), b.get("prescription"), b.get("payment"))
    if not isinstance(items, list) or not items:
        return J({"error": "Cart is empty"}, 400)
    if otype == "delivery" and not address:
        return J({"error": "Delivery address is required"}, 400)

    # --- step 1: payment must be present, ours, unused, and genuine ---
    provider_order_id = payments.order_id_of(payment) if payment else None
    if not provider_order_id:
        return J({"error": "Payment required"}, 402)
    pay = db.get("SELECT * FROM payments WHERE provider_order_id = ? AND patient_id = ?", (provider_order_id, user["id"]))
    if not pay or pay["status"] != "created":
        return J({"error": "Unknown or already-used payment"}, 402)
    if not payments.verify(provider_order_id, payment):
        return J({"error": "Payment verification failed"}, 402)

    def place_order():
        # steps 2 & 3 run inside the transaction below. Re-pricing here (rather than trusting the
        # total from checkout) is what makes the anti-tamper check meaningful.
        total, pharmacy_id, lines = price_cart(items, reserve=True)
        if round(total * 100) != pay["amount"]:  # anti-tamper: paid amount must match the cart
            raise ValueError("Paid amount does not match cart total")
        prescription_id = None
        if prescription:
            prescription_id = db.run("INSERT INTO prescriptions (patient_id, kind, content) VALUES (?, 'uploaded', ?)",
                                     (user["id"], crypto.encrypt(prescription)))
        oid = db.run("INSERT INTO orders (patient_id, pharmacy_id, type, address, total, prescription_id) "
                     "VALUES (?, ?, ?, ?, ?, ?)",
                     (user["id"], pharmacy_id, "pickup" if otype == "pickup" else "delivery",
                      address or None, total, prescription_id))
        for med, qty in lines:
            db.run("INSERT INTO order_items (order_id, medicine_id, name, price, qty) VALUES (?, ?, ?, ?, ?)",
                   (oid, med["id"], med["name"], med["price"], qty))
            # schedule a refill reminder REFILL_DAYS from now for each medicine bought
            db.run("INSERT INTO refill_reminders (patient_id, medicine_name, due_date) VALUES (?, ?, ?)",
                   (user["id"], med["name"], _plus_days(REFILL_DAYS)))
        db.run("UPDATE payments SET status = 'paid', order_id = ? WHERE id = ?", (oid, pay["id"]))
        # step 4: announce what happened; consumers turn these into logs, receipts, notifications
        events.publish(TOPICS["ORDERS"], {"orderId": oid, "pharmacyId": pharmacy_id, "patientId": user["id"], "total": total})
        events.publish(TOPICS["PAYMENTS"], {"orderId": oid, "patientId": user["id"], "amount": pay["amount"]})
        notify(pharmacy_id, f"New order #{oid} received (₹{total:.2f})")
        return oid

    try:
        with db.transaction():  # commit on success, roll back on any raised error
            order_id = place_order()
        db.audit(user, "order.placed", f"order #{order_id}")
        return J(db.get("SELECT * FROM orders WHERE id = ?", (order_id,)))
    except ValueError as e:
        return J({"error": str(e)}, 400)


@auth("pharmacy")
def order_detail(request, id):
    """PATCH /api/orders/<id> — pharmacy advances the order one step along its pipeline
    (pending -> preparing -> shipped/ready -> delivered/picked_up, branching on delivery vs pickup)."""
    user = request.user
    order = db.get("SELECT * FROM orders WHERE id = ? AND pharmacy_id = ?", (id, user["id"]))
    if not order:
        return J({"error": "Order not found"}, 404)
    nxt = NEXT_STATUS.get(order["status"])
    if order["status"] == "preparing":  # the one branch: delivery ships, pickup becomes ready
        nxt = "shipped" if order["type"] == "delivery" else "ready"
    if not nxt:
        return J({"error": "Order is already complete"}, 400)
    db.run("UPDATE orders SET status = ? WHERE id = ?", (nxt, order["id"]))
    notify(order["patient_id"], f"Order #{order['id']} is now {nxt.replace('_', ' ')}")
    return J(db.get("SELECT * FROM orders WHERE id = ?", (order["id"],)))


# ==================== appointments ====================
@api
def appointments(request):
    """GET /api/appointments — list (scoped to patient/doctor/admin).
    POST /api/appointments — patient books a slot with a doctor (starts 'pending')."""
    if request.method == "POST":
        user, err = require_auth(request, "patient")
        if err:
            return err
        b = request.data
        doctor = db.get("SELECT * FROM users WHERE id = ? AND role = 'doctor' AND status = 'approved'", (b.get("doctor_id"),))
        if not doctor:
            return J({"error": "Doctor not found"}, 404)
        if not b.get("slot"):
            return J({"error": "Please pick a slot"}, 400)
        aid = db.run("INSERT INTO appointments (patient_id, doctor_id, slot) VALUES (?, ?, ?)",
                     (user["id"], doctor["id"], b["slot"]))
        notify(doctor["id"], f"New appointment request from {user['name']} — {b['slot']}")
        return J(db.get("SELECT * FROM appointments WHERE id = ?", (aid,)))
    user, err = require_auth(request)
    if err:
        return err
    # patients see their own appointments, doctors their own, admins everything
    where, params = role_scope(user, {"patient": "a.patient_id", "doctor": "a.doctor_id", "admin": None})
    return J(db.query(
        "SELECT a.*, p.name AS patient_name, d.name AS doctor_name, d.specialization, d.fee FROM appointments a "
        "JOIN users p ON p.id = a.patient_id JOIN users d ON d.id = a.doctor_id "
        f"{where} ORDER BY a.id DESC", params))


@auth("doctor")
def appointment_detail(request, id):
    """PATCH /api/appointments/<id> — doctor accepts/rejects/completes their own appointment."""
    user = request.user
    appt = db.get("SELECT * FROM appointments WHERE id = ? AND doctor_id = ?", (id, user["id"]))
    if not appt:
        return J({"error": "Appointment not found"}, 404)
    status = request.data.get("status")
    if status not in ("confirmed", "rejected", "completed"):
        return J({"error": "Invalid status"}, 400)
    db.run("UPDATE appointments SET status = ? WHERE id = ?", (status, appt["id"]))
    notify(appt["patient_id"], f"Appointment with {user['name']} ({appt['slot']}) was {status}")
    return J(db.get("SELECT * FROM appointments WHERE id = ?", (appt["id"],)))


def appt_for_user(id, user):
    """Return the appointment only if this user is a party to it (its patient or its doctor);
    otherwise None. This is the access check for the consultation chat/video below."""
    appt = db.get("SELECT * FROM appointments WHERE id = ?", (id,))
    if not appt:
        return None
    if user["role"] == "patient" and appt["patient_id"] == user["id"]:
        return appt
    if user["role"] == "doctor" and appt["doctor_id"] == user["id"]:
        return appt
    return None


# ==================== teleconsultation: chat + video ====================
@auth("patient", "doctor")
def appointment_messages(request, id):
    """GET .../messages — read the consultation thread.  POST .../messages — send a message.
    Only the two parties can access it, and only once the appointment is confirmed."""
    user = request.user
    appt = appt_for_user(id, user)
    if not appt:
        return J({"error": "Appointment not found"}, 404)  # also the "you're not a party" response
    if request.method == "POST":
        if appt["status"] not in ("confirmed", "completed"):
            return J({"error": "Consultation opens once the appointment is confirmed"}, 400)
        if not non_empty(request.data.get("body")):
            return J({"error": "Message cannot be empty"}, 400)
        mid = db.run("INSERT INTO messages (appointment_id, sender_id, body) VALUES (?, ?, ?)",
                     (appt["id"], user["id"], crypto.encrypt(request.data["body"].strip())))
        other = appt["doctor_id"] if user["id"] == appt["patient_id"] else appt["patient_id"]
        notify(other, f"New consultation message from {user['name']}")
        row = db.get("SELECT * FROM messages WHERE id = ?", (mid,))
        row["body"] = crypto.decrypt(row["body"])
        return J(row)
    rows = db.query(
        "SELECT m.*, u.name AS sender_name, u.role AS sender_role FROM messages m "
        "JOIN users u ON u.id = m.sender_id WHERE m.appointment_id = ? ORDER BY m.id", (appt["id"],))
    for r in rows:
        r["body"] = crypto.decrypt(r["body"])  # decrypt consultation messages on the way out
    return J(rows)


@auth("patient", "doctor")
def appointment_room(request, id):
    """GET /api/appointments/<id>/room — return a Jitsi video-room URL for this appointment.
    The room name is derived from a secret + the id, so it's stable for both parties but not guessable."""
    user = request.user
    appt = appt_for_user(id, user)
    if not appt:
        return J({"error": "Appointment not found"}, 404)
    if appt["status"] not in ("confirmed", "completed"):
        return J({"error": "Video call opens once the appointment is confirmed"}, 400)
    import hashlib
    token_part = hashlib.sha256(f"{CONSULT_SECRET}:{appt['id']}".encode()).hexdigest()[:12]
    room = f"epharma-appt-{appt['id']}-{token_part}"
    return J({"room": room, "url": f"https://meet.jit.si/{room}"})


# ==================== refills & prescriptions ====================
@auth("patient")
def refills(request):
    """GET /api/refills — patient. Their scheduled refill reminders (soonest first)."""
    user = request.user
    return J(db.query("SELECT * FROM refill_reminders WHERE patient_id = ? ORDER BY due_date", (user["id"],)))


@api
def prescriptions(request):
    """GET /api/prescriptions — patient sees theirs, doctor sees ones they wrote.
    POST /api/prescriptions — doctor writes an e-prescription (also marks the appointment complete)."""
    if request.method == "POST":
        user, err = require_auth(request, "doctor")
        if err:
            return err
        b = request.data
        appt = db.get("SELECT * FROM appointments WHERE id = ? AND doctor_id = ?", (b.get("appointment_id"), user["id"]))
        if not appt:
            return J({"error": "Appointment not found"}, 404)
        if not b.get("content"):
            return J({"error": "Prescription text is required"}, 400)
        pid = db.run("INSERT INTO prescriptions (patient_id, doctor_id, appointment_id, kind, content) "
                     "VALUES (?, ?, ?, 'eprescription', ?)", (appt["patient_id"], user["id"], appt["id"], crypto.encrypt(b["content"])))
        db.run("UPDATE appointments SET status = 'completed' WHERE id = ?", (appt["id"],))
        db.audit(user, "prescription.created", f"patient #{appt['patient_id']}")
        notify(appt["patient_id"], f"e-Prescription uploaded by {user['name']}")
        return J(db.get("SELECT * FROM prescriptions WHERE id = ?", (pid,)))
    user, err = require_auth(request)
    if err:
        return err
    # medical records are narrower than orders: only the patient and the prescribing doctor —
    # admins are deliberately NOT given a role here.
    where, params = role_scope(user, {"patient": "p.patient_id", "doctor": "p.doctor_id"})
    rows = db.query(
        "SELECT p.*, pat.name AS patient_name, doc.name AS doctor_name FROM prescriptions p "
        "JOIN users pat ON pat.id = p.patient_id LEFT JOIN users doc ON doc.id = p.doctor_id "
        f"{where} ORDER BY p.id DESC", params)
    for r in rows:
        r["content"] = crypto.decrypt(r["content"])  # decrypt medical record on the way out
    return J(rows)


@auth("patient")
def prescriptions_upload(request):
    """POST /api/prescriptions/upload — patient uploads a prescription image (base64 data URL)."""
    user = request.user
    content = request.data.get("content")
    if not content:
        return J({"error": "No file received"}, 400)
    pid = db.run("INSERT INTO prescriptions (patient_id, kind, content) VALUES (?, 'uploaded', ?)", (user["id"], crypto.encrypt(content)))
    row = db.get("SELECT * FROM prescriptions WHERE id = ?", (pid,))
    row["content"] = crypto.decrypt(row["content"])
    return J(row)


# ==================== notifications & earnings ====================
@auth()
def notifications(request):
    """GET /api/notifications — latest 30 for the caller. For patients, first materialise any
    refill reminders that have come due (so they show up here without a background job)."""
    user = request.user
    if user["role"] == "patient":
        run_due_refills(user["id"])
    return J(db.query("SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30", (user["id"],)))


@auth()
def notifications_read(request):
    """POST /api/notifications/read — mark all of the caller's notifications as read."""
    user = request.user
    db.run("UPDATE notifications SET read = 1 WHERE user_id = ?", (user["id"],))
    return J({"ok": True})


@auth("doctor")
def earnings(request):
    """GET /api/earnings — doctor. Completed-consultation count and total (count × fee)."""
    user = request.user
    row = db.get("SELECT COUNT(*) AS consultations FROM appointments WHERE doctor_id = ? AND status = 'completed'", (user["id"],))
    return J({"consultations": row["consultations"], "total": row["consultations"] * (user["fee"] or 0)})


# ==================== admin ====================
@auth("admin")
def admin_users(request):
    """GET /api/admin/users?status=&role= — admin. All non-admin users, optionally filtered."""
    sql, params = "SELECT * FROM users WHERE role != 'admin'", []
    if request.GET.get("status"):
        sql += " AND status = ?"
        params.append(request.GET["status"])
    if request.GET.get("role"):
        sql += " AND role = ?"
        params.append(request.GET["role"])
    return J([db.public_user(u) for u in db.query(sql + " ORDER BY id DESC", params)])


@auth("admin")
def admin_user_detail(request, id):
    """PATCH /api/admin/users/<id> — admin approves or rejects a pending doctor/pharmacy."""
    user = request.user
    target = db.get("SELECT * FROM users WHERE id = ?", (id,))
    if not target:
        return J({"error": "User not found"}, 404)
    status = request.data.get("status")
    if status not in ("approved", "rejected"):
        return J({"error": "Invalid status"}, 400)
    db.run("UPDATE users SET status = ? WHERE id = ?", (status, target["id"]))
    db.audit(user, f"user.{status}", f"{target['role']} #{target['id']} ({target['email']})")
    notify(target["id"], f"Your {target['role']} account was {status} by the admin")
    return J(db.public_user(db.get("SELECT * FROM users WHERE id = ?", (target["id"],))))


@auth("admin")
def admin_stats(request):
    """GET /api/admin/stats — admin. Headline KPI counts for the dashboard overview."""

    def c(sql):
        return db.get(sql)["c"]

    return J({
        "patients": c("SELECT COUNT(*) AS c FROM users WHERE role = 'patient'"),
        "doctors": c("SELECT COUNT(*) AS c FROM users WHERE role = 'doctor' AND status = 'approved'"),
        "pharmacies": c("SELECT COUNT(*) AS c FROM users WHERE role = 'pharmacy' AND status = 'approved'"),
        "pending_approvals": c("SELECT COUNT(*) AS c FROM users WHERE status = 'pending'"),
        "orders": c("SELECT COUNT(*) AS c FROM orders"),
        "revenue": db.get("SELECT COALESCE(SUM(total), 0) AS s FROM orders")["s"],
        "appointments": c("SELECT COUNT(*) AS c FROM appointments"),
    })


@auth("admin")
def admin_reports(request):
    """GET /api/admin/reports — admin. Aggregation queries powering the Reports charts."""
    # NOTE: CAST(...AS TEXT) and CAST(...AS NUMERIC) keep these portable across SQLite and Postgres
    # (Postgres can't substr a timestamp, and its ROUND needs numeric input).
    return J({
        "revenue_by_day": db.query("SELECT substr(CAST(created_at AS TEXT),1,10) AS day, ROUND(CAST(SUM(total) AS NUMERIC),2) AS revenue, COUNT(*) AS orders FROM orders GROUP BY substr(CAST(created_at AS TEXT),1,10) ORDER BY day"),
        "orders_by_status": db.query("SELECT status, COUNT(*) AS count FROM orders GROUP BY status"),
        "top_medicines": db.query("SELECT name, SUM(qty) AS units, ROUND(CAST(SUM(price*qty) AS NUMERIC),2) AS revenue FROM order_items GROUP BY name ORDER BY units DESC LIMIT 5"),
        "revenue_by_pharmacy": db.query("SELECT u.store_name AS pharmacy, ROUND(CAST(SUM(o.total) AS NUMERIC),2) AS revenue, COUNT(*) AS orders FROM orders o JOIN users u ON u.id=o.pharmacy_id GROUP BY u.store_name ORDER BY revenue DESC"),
        "appointments_by_status": db.query("SELECT status, COUNT(*) AS count FROM appointments GROUP BY status"),
        "consultations": db.get("SELECT COUNT(*) AS total, COALESCE(SUM(d.fee),0) AS revenue FROM appointments a JOIN users d ON d.id=a.doctor_id WHERE a.status='completed'"),
    })


@auth("admin")
def admin_taxonomy(request):
    """POST /api/admin/taxonomy — admin adds a category or specialty (ignored if it already exists)."""
    b = request.data
    if b.get("type") not in ("category", "specialty") or not non_empty(b.get("name")):
        return J({"error": "A type (category/specialty) and name are required"}, 400)
    db.run("INSERT INTO taxonomy (type, name) VALUES (?, ?) ON CONFLICT DO NOTHING", (b["type"], b["name"].strip()))
    return J(db.get("SELECT * FROM taxonomy WHERE type = ? AND name = ?", (b["type"], b["name"].strip())))


@auth("admin")
def admin_taxonomy_detail(request, id):
    """DELETE /api/admin/taxonomy/<id> — admin removes a category or specialty."""
    db.run("DELETE FROM taxonomy WHERE id = ?", (id,))
    return J({"ok": True})


@auth("admin")
def admin_cms(request, slug):
    """PUT /api/admin/cms/<slug> — admin creates or updates a CMS page (upsert on slug)."""
    user = request.user
    b = request.data
    if not non_empty(b.get("title")) or not non_empty(b.get("body")):
        return J({"error": "Title and body are required"}, 400)
    db.run("INSERT INTO cms_pages (slug, title, body, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) "
           "ON CONFLICT(slug) DO UPDATE SET title = excluded.title, body = excluded.body, updated_at = excluded.updated_at",
           (slug, b["title"].strip(), b["body"]))
    db.audit(user, "cms.update", slug)
    return J(db.get("SELECT * FROM cms_pages WHERE slug = ?", (slug,)))


@auth("admin")
def admin_audit(request):
    """GET /api/admin/audit — admin. The most recent 100 audit-trail entries (security review)."""
    return J(db.query("SELECT * FROM audit_log ORDER BY id DESC LIMIT 100"))


# ==================== fallthrough: unknown API route + SPA files ====================
@api
def api_not_found(request, *a, **kw):
    """Any /api/... path that matched nothing above -> JSON 404 (not Django's HTML page)."""
    return J({"error": "Endpoint not found"}, 404)


@csrf_exempt
def serve_public(request, path=""):
    """Serve the SPA from public/. Unknown paths fall back to index.html (single-page app routing).
    The startswith check keeps requests from escaping the public/ directory (path-traversal guard)."""
    rel = path or "index.html"
    full = os.path.normpath(os.path.join(PUBLIC_DIR, rel))
    if not full.startswith(PUBLIC_DIR) or not os.path.isfile(full):
        full = os.path.join(PUBLIC_DIR, "index.html")
    ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
    with open(full, "rb") as f:
        return HttpResponse(f.read(), content_type=ctype)
