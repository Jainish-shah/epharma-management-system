"""Data layer — works on SQLite (default, zero-config) OR PostgreSQL (Phase 5).

Set DATABASE_URL=postgres://user:pass@host/db to run on PostgreSQL; otherwise a local SQLite file
is used. The rest of the app calls the same four helpers (query/get/run/execute) either way — this
module hides every dialect difference (placeholder style, RETURNING vs lastrowid, schema types).

We deliberately use the raw driver (not the Django ORM) so the SQL and JSON shapes stay explicit.
"""
import contextlib
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
from datetime import datetime, timezone

from . import crypto  # encryption at rest for sensitive columns

DB_PATH = os.environ.get("EPHARMA_DB") or os.path.join(os.path.dirname(os.path.dirname(__file__)), "epharma.db")
DATABASE_URL = os.environ.get("DATABASE_URL")
IS_PG = bool(DATABASE_URL and DATABASE_URL.startswith(("postgres://", "postgresql://")))  # else SQLite

if IS_PG:
    import psycopg
    from psycopg.rows import dict_row
    # client_encoding=UTF8 so Unicode content (₹, em-dashes, names) round-trips regardless of server locale
    _conn = psycopg.connect(DATABASE_URL, autocommit=True, row_factory=dict_row, client_encoding="UTF8")
else:
    # timeout: wait for a lock instead of failing instantly — several server workers boot at once
    # and briefly contend while creating/seeding the schema.
    _conn = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None, timeout=20)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA busy_timeout = 20000")  # set FIRST so every later statement waits its turn
    try:
        # WAL lets readers run alongside the writer. It is a persistent property of the database
        # file, so if a sibling worker is mid-switch and this fails, the mode is (or is about to be)
        # set anyway — not worth failing a boot over.
        _conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.OperationalError:
        pass
    _conn.execute("PRAGMA foreign_keys = ON")
_lock = threading.RLock()  # serialise access (dev server is threaded; one shared connection)


def _sql(s):
    # Call sites write SQLite-style `?` placeholders; psycopg wants `%s`. Translate for Postgres.
    return s.replace("?", "%s") if IS_PG else s


# The four helpers below are the entire data layer. Every SQL value is bound as a parameter (never
# string-formatted in), which keeps the app safe from SQL injection.

def query(sql, params=()):
    """Run a SELECT and return ALL matching rows as a list of dicts."""
    with _lock:
        rows = _conn.execute(_sql(sql), params).fetchall()
        return rows if IS_PG else [dict(r) for r in rows]


def get(sql, params=()):
    """Run a SELECT and return the FIRST row as a dict (or None if there is none)."""
    with _lock:
        row = _conn.execute(_sql(sql), params).fetchone()
        if not row:
            return None
        return row if IS_PG else dict(row)


def run(sql, params=()):
    """Run an INSERT/UPDATE/DELETE and return the new row's id.
    SQLite gives us lastrowid for free; Postgres has no lastrowid, so for plain inserts we append
    `RETURNING id` and read it back (skipped for UPDATE/DELETE and for `ON CONFLICT` upserts)."""
    with _lock:
        if IS_PG:
            s = _sql(sql)
            is_insert = s.lstrip().upper().startswith("INSERT") and "ON CONFLICT" not in s.upper()
            if is_insert:
                s = s.rstrip().rstrip(";") + " RETURNING id"
            cur = _conn.execute(s, params)
            if is_insert:
                r = cur.fetchone()
                return r["id"] if r else None
            return None
        cur = _conn.execute(sql, params)
        return cur.lastrowid


def execute(script):
    """Run a multi-statement SQL script (used once to create the schema).

    psycopg sends one statement at a time, so the script is split on ';'. Comments are stripped
    first: a ';' inside a '--' comment would otherwise split a statement in half. (The schema has no
    string literal containing '--', so removing from '--' to end of line is safe here.)
    """
    with _lock:
        if IS_PG:
            cleaned = "\n".join(re.sub(r"--.*$", "", line) for line in script.split("\n"))
            for stmt in cleaned.split(";"):
                if stmt.strip():
                    _conn.execute(stmt)
        else:
            _conn.executescript(script)  # SQLite handles comments and multiple statements itself


# Wrap a block of writes so they all succeed together or none do:
#   with db.transaction():
#       ... several db.run(...) calls ...
# If the block raises, everything is rolled back (used by order placement so stock/order stay in sync).
#
# `immediate=True` takes the write lock up front on SQLite (BEGIN IMMEDIATE) instead of on first
# write, so a read-then-write sequence can't interleave with another process. Needed when several
# server workers boot at once — see init_and_seed().
@contextlib.contextmanager
def transaction(immediate=False):
    with _lock:
        if IS_PG:
            with _conn.transaction():
                yield
        else:
            _conn.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
            try:
                yield
                _conn.execute("COMMIT")
            except Exception:
                _conn.execute("ROLLBACK")
                raise


# ---- password hashing (scrypt, matches Node crypto.scryptSync defaults N=16384 r=8 p=1, keylen 64) ----
def hash_password(password):
    salt = secrets.token_hex(16)
    h = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1, dklen=64, maxmem=64 * 1024 * 1024)
    return f"{salt}:{h.hex()}"


def verify_password(password, stored):
    try:
        salt, h = stored.split(":")
    except (ValueError, AttributeError):
        return False
    cand = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1, dklen=64, maxmem=64 * 1024 * 1024)
    return hmac.compare_digest(bytes.fromhex(h), cand)


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('patient','doctor','pharmacy','admin')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved','rejected')),
  specialization TEXT, qualification TEXT, fee INTEGER, availability TEXT,
  store_name TEXT, license_no TEXT, gstin TEXT, address TEXT, documents TEXT,
  -- Phase 7 (compliance): which privacy-policy version the user accepted, and when.
  consent_version TEXT, consent_at TEXT,
  -- Set when the account has been erased on request; personal fields are overwritten, while
  -- de-identified medical and order records are kept for the legally required retention period.
  anonymised_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))   -- lets stale sessions be purged (Phase 7)
);
CREATE TABLE IF NOT EXISTS medicines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL, category TEXT NOT NULL, price REAL NOT NULL, stock INTEGER NOT NULL DEFAULT 0
);
-- Tables are declared in dependency order (a table's REFERENCES targets must already exist —
-- SQLite tolerates forward references, PostgreSQL does not).
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  doctor_id INTEGER NOT NULL REFERENCES users(id),
  slot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected','completed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS prescriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  doctor_id INTEGER REFERENCES users(id),
  appointment_id INTEGER REFERENCES appointments(id),
  kind TEXT NOT NULL CHECK (kind IN ('uploaded','eprescription')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  pharmacy_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending',
  type TEXT NOT NULL DEFAULT 'delivery' CHECK (type IN ('delivery','pickup')),
  address TEXT, total REAL NOT NULL,
  prescription_id INTEGER REFERENCES prescriptions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  name TEXT NOT NULL, price REAL NOT NULL, qty INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS otps (email TEXT PRIMARY KEY, code TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_order_id TEXT NOT NULL UNIQUE,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed')),
  order_id INTEGER REFERENCES orders(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS refill_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  medicine_name TEXT NOT NULL, due_date TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS taxonomy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('category','specialty')),
  name TEXT NOT NULL, UNIQUE(type, name)
);
CREATE TABLE IF NOT EXISTS cms_pages (
  slug TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Phase 5: security audit trail — who did what, when (logins, approvals, orders, prescriptions...).
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, actor TEXT, action TEXT NOT NULL, detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


# Arbitrary but fixed id for the PostgreSQL advisory lock that serialises schema creation/seeding.
_INIT_LOCK_ID = 8274613509


def _pg_schema(s):
    """Translate the canonical SQLite schema above into PostgreSQL dialect."""
    return (s.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")
             .replace("TEXT NOT NULL DEFAULT (datetime('now'))", "TIMESTAMPTZ NOT NULL DEFAULT now()")
             .replace("REAL", "DOUBLE PRECISION"))


def _columns(table):
    if IS_PG:
        rows = query("SELECT column_name AS name FROM information_schema.columns WHERE table_name = ?", (table,))
    else:
        rows = query(f"PRAGMA table_info({table})")
    return {r["name"] for r in rows}


# Columns added after the first release. CREATE TABLE IF NOT EXISTS does not alter an existing
# table, so a database created by an earlier version needs them added — additively, never dropping
# or rewriting anything, so upgrading cannot lose data.
_ADDED_COLUMNS = [
    ("users", "consent_version", "TEXT"),
    ("users", "consent_at", "TEXT"),
    ("users", "anonymised_at", "TEXT"),
    ("tokens", "created_at", "TEXT"),
]


def _migrate():
    for table, column, coltype in _ADDED_COLUMNS:
        if column not in _columns(table):
            run(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}")


def init_and_seed():
    """Create the tables (no-op if they already exist), apply additive migrations, then load demo
    data — but only on a fresh database. An existing database is left untouched, so restarts never
    wipe data.

    Safe to call from several processes at once: production runs multiple server workers, and they
    all boot simultaneously. The check-and-seed happens inside one transaction (with the write lock
    taken up front on SQLite); should two workers still race, the loser hits a unique-constraint
    error, re-checks, and exits quietly because the winner has already seeded.
    """
    if IS_PG:
        # PostgreSQL's CREATE TABLE IF NOT EXISTS is NOT atomic against a concurrent creation of the
        # same table (both sessions see "not exists" and one fails on pg_type). An advisory lock
        # serialises schema creation and seeding across workers; it is released in the finally block.
        _conn.execute("SELECT pg_advisory_lock(%s)", (_INIT_LOCK_ID,))
    try:
        execute(_pg_schema(SCHEMA) if IS_PG else SCHEMA)
        _migrate()
        try:
            with transaction(immediate=True):
                if get("SELECT COUNT(*) AS c FROM users")["c"] != 0:
                    return
                _seed_demo_data()
        except Exception:
            if get("SELECT COUNT(*) AS c FROM users")["c"] == 0:
                raise  # genuinely failed, not a lost race
            return
    finally:
        if IS_PG:
            _conn.execute("SELECT pg_advisory_unlock(%s)", (_INIT_LOCK_ID,))


def _seed_demo_data():
    """Insert the demo users, catalog, taxonomy and CMS pages. Called once, on a fresh database."""

    # Demo accounts are created as though they had accepted the current privacy policy, so the
    # seeded data matches what a real registration produces.
    from . import compliance
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    def add_user(**u):
        cols = ["role", "name", "email", "phone", "password_hash", "status", "specialization",
                "qualification", "fee", "availability", "store_name", "license_no", "gstin", "address",
                "consent_version", "consent_at"]
        vals = [u.get("role"), u.get("name"), u.get("email"), u.get("phone"),
                hash_password(u["password"]), u.get("status", "approved"),
                u.get("specialization"), u.get("qualification"), u.get("fee"), u.get("availability"),
                u.get("store_name"), u.get("license_no"), u.get("gstin"), u.get("address"),
                compliance.POLICY_VERSION, now]
        return run(f"INSERT INTO users ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", vals)

    add_user(role="admin", name="System Admin", email="admin@epharma.com", password="admin123")
    add_user(role="doctor", name="Dr. Asha Mehta", email="asha@epharma.com", password="doctor123",
             specialization="Cardiology", qualification="MBBS, MD (Cardiology)", fee=600,
             availability="Mon 10:00, Mon 11:00, Wed 15:00, Fri 10:00", phone="9876500001")
    add_user(role="doctor", name="Dr. Rohan Iyer", email="rohan@epharma.com", password="doctor123",
             specialization="Dermatology", qualification="MBBS, MD (Dermatology)", fee=500,
             availability="Tue 09:00, Tue 10:00, Thu 14:00, Sat 11:00", phone="9876500002")
    add_user(role="doctor", name="Dr. Kunal Shah", email="kunal@epharma.com", password="doctor123",
             status="pending", specialization="Orthopedics", qualification="MBBS, MS (Ortho)", fee=700,
             availability="Mon 16:00, Wed 16:00", phone="9876500003")
    medplus = add_user(role="pharmacy", name="Ramesh Gupta", email="store@medplus.com", password="pharma123",
                       store_name="MedPlus Pharmacy", license_no="DL-MH-12345", gstin="27ABCDE1234F1Z5",
                       address="Shop 4, FC Road, Pune", phone="9876500010")
    add_user(role="pharmacy", name="Sunita Rao", email="store@healthkart.com", password="pharma123",
             status="pending", store_name="HealthKart Chemist", license_no="DL-MH-67890",
             gstin="27FGHIJ5678K2Z9", address="MG Road, Pune", phone="9876500011")
    add_user(role="patient", name="Priya Sharma", email="priya@gmail.com", password="patient123",
             phone="9876500020", address="12 Rose Villa, Baner, Pune")

    meds = [
        ("Paracetamol 500mg (10 tabs)", "Pain Relief", 30, 200),
        ("Ibuprofen 400mg (10 tabs)", "Pain Relief", 45, 150),
        ("Amoxicillin 250mg (10 caps)", "Antibiotics", 80, 90),
        ("Azithromycin 500mg (3 tabs)", "Antibiotics", 110, 70),
        ("Cetirizine 10mg (10 tabs)", "Allergy", 25, 300),
        ("Metformin 500mg (20 tabs)", "Diabetes", 60, 120),
        ("Insulin Glargine 100IU", "Diabetes", 850, 40),
        ("Amlodipine 5mg (15 tabs)", "Blood Pressure", 55, 100),
        ("Omeprazole 20mg (15 caps)", "Digestive", 70, 110),
        ("Cough Syrup 100ml", "Cold & Flu", 95, 80),
        ("Vitamin D3 60K (4 caps)", "Supplements", 130, 140),
        ("ORS Sachets (pack of 5)", "Hydration", 40, 250),
    ]
    for m in meds:
        run("INSERT INTO medicines (pharmacy_id, name, category, price, stock) VALUES (?, ?, ?, ?, ?)", (medplus, *m))

    # Pending doctor & pharmacy ship with demo verification documents so the admin approval flow is demoable.
    def placeholder_doc(text):
        from urllib.parse import quote
        svg = (f"<svg xmlns='http://www.w3.org/2000/svg' width='340' height='190'>"
               f"<rect width='100%' height='100%' fill='#e0f2f1'/>"
               f"<text x='18' y='100' font-family='sans-serif' font-size='16' fill='#0f766e'>{text}</text></svg>")
        return "data:image/svg+xml," + quote(svg)

    run("UPDATE users SET documents = ? WHERE email = ?", (crypto.encrypt(json.dumps({
        "Degree certificate": placeholder_doc("MBBS Degree — Dr. Kunal Shah"),
        "Medical license": placeholder_doc("Medical License MH-ORTHO-2231"),
    })), "kunal@epharma.com"))
    run("UPDATE users SET documents = ? WHERE email = ?", (crypto.encrypt(json.dumps({
        "Drug license": placeholder_doc("Drug License DL-MH-67890"),
        "GSTIN proof": placeholder_doc("GSTIN 27FGHIJ5678K2Z9"),
    })), "store@healthkart.com"))

    for c in sorted({m[1] for m in meds}):
        run("INSERT INTO taxonomy (type, name) VALUES ('category', ?) ON CONFLICT DO NOTHING", (c,))
    for s in ["Cardiology", "Dermatology", "Orthopedics", "General Physician", "Pediatrics"]:
        run("INSERT INTO taxonomy (type, name) VALUES ('specialty', ?) ON CONFLICT DO NOTHING", (s,))

    cms = [
        ("faq", "Frequently Asked Questions",
         "Q: How do I order medicines?\nBrowse or search, add to cart, and check out with a prescription if required.\n\n"
         "Q: How do consultations work?\nBook a doctor, and once confirmed you can chat or start a video call.\n\n"
         "Q: Are my prescriptions private?\nYes — they are visible only to you and the pharmacy or doctor involved in your order."),
        ("terms", "Terms of Service",
         "By using E-Pharma you agree to provide accurate information, use the platform lawfully, and follow prescription "
         "requirements for regulated medicines. Orders and consultations are subject to pharmacy and doctor availability."),
        ("privacy", "Privacy Policy",
         "We store your account details, orders, prescriptions and consultation records to provide the service. Access is "
         "role-based; medical records are shared only with the parties involved in your care. You may request deletion of your data."),
    ]
    for slug, title, body in cms:
        run("INSERT INTO cms_pages (slug, title, body) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", (slug, title, body))


def issue_token(user_id):
    """Create a fresh random session token for a user and store it (login/register call this).
    created_at is set explicitly rather than by a column default, because the column is added by
    migration on databases that predate it and so carries no default there."""
    token = secrets.token_hex(24)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    run("INSERT INTO tokens (token, user_id, created_at) VALUES (?, ?, ?)", (token, user_id, now))
    return token


def public_user(u):
    """Strip the password hash, and decrypt verification documents, before a user object is
    ever sent to the client."""
    out = {k: v for k, v in u.items() if k != "password_hash"}
    if out.get("documents"):
        out["documents"] = crypto.decrypt(out["documents"])
    return out


def audit(user, action, detail=None):
    """Phase 5: record a security-relevant action in the audit trail.
    `user` may be a user dict (logged-in actor) or None (anonymous/failed attempts)."""
    uid = user["id"] if user else None
    actor = f"{user['name']} ({user['role']})" if user else "anonymous"
    run("INSERT INTO audit_log (user_id, actor, action, detail) VALUES (?, ?, ?, ?)", (uid, actor, action, detail))
