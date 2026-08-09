"""SQLite data layer — Python port of db.js (schema, seed, helpers).

Uses stdlib sqlite3 directly (not the Django ORM) so the exact SQL and JSON shapes from the
original Node backend are preserved and the frontend needs no changes.
"""
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading

DB_PATH = os.environ.get("EPHARMA_DB") or os.path.join(os.path.dirname(os.path.dirname(__file__)), "epharma.db")

_conn = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)  # autocommit; explicit BEGIN for txns
_conn.row_factory = sqlite3.Row
_conn.execute("PRAGMA journal_mode = WAL")
_conn.execute("PRAGMA foreign_keys = ON")
_lock = threading.RLock()  # serialise writes (dev server is threaded)


def query(sql, params=()):
    with _lock:
        return [dict(r) for r in _conn.execute(sql, params).fetchall()]


def get(sql, params=()):
    with _lock:
        row = _conn.execute(sql, params).fetchone()
        return dict(row) if row else None


def run(sql, params=()):
    with _lock:
        cur = _conn.execute(sql, params)
        return cur.lastrowid


def execute(script):
    with _lock:
        _conn.executescript(script)


# ---- transactions (mirror the node BEGIN/COMMIT/ROLLBACK order path) ----
import contextlib


@contextlib.contextmanager
def transaction():
    with _lock:
        _conn.execute("BEGIN")
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id));
CREATE TABLE IF NOT EXISTS medicines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL, category TEXT NOT NULL, price REAL NOT NULL, stock INTEGER NOT NULL DEFAULT 0
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
"""


def init_and_seed():
    execute(SCHEMA)
    if get("SELECT COUNT(*) AS c FROM users")["c"] != 0:
        return

    def add_user(**u):
        cols = ["role", "name", "email", "phone", "password_hash", "status", "specialization",
                "qualification", "fee", "availability", "store_name", "license_no", "gstin", "address"]
        vals = [u.get("role"), u.get("name"), u.get("email"), u.get("phone"),
                hash_password(u["password"]), u.get("status", "approved"),
                u.get("specialization"), u.get("qualification"), u.get("fee"), u.get("availability"),
                u.get("store_name"), u.get("license_no"), u.get("gstin"), u.get("address")]
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

    run("UPDATE users SET documents = ? WHERE email = ?", (json.dumps({
        "Degree certificate": placeholder_doc("MBBS Degree — Dr. Kunal Shah"),
        "Medical license": placeholder_doc("Medical License MH-ORTHO-2231"),
    }), "kunal@epharma.com"))
    run("UPDATE users SET documents = ? WHERE email = ?", (json.dumps({
        "Drug license": placeholder_doc("Drug License DL-MH-67890"),
        "GSTIN proof": placeholder_doc("GSTIN 27FGHIJ5678K2Z9"),
    }), "store@healthkart.com"))

    for c in sorted({m[1] for m in meds}):
        run("INSERT OR IGNORE INTO taxonomy (type, name) VALUES ('category', ?)", (c,))
    for s in ["Cardiology", "Dermatology", "Orthopedics", "General Physician", "Pediatrics"]:
        run("INSERT OR IGNORE INTO taxonomy (type, name) VALUES ('specialty', ?)", (s,))

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
        run("INSERT OR IGNORE INTO cms_pages (slug, title, body) VALUES (?, ?, ?)", (slug, title, body))


def issue_token(user_id):
    token = secrets.token_hex(24)
    run("INSERT INTO tokens (token, user_id) VALUES (?, ?)", (token, user_id))
    return token


def public_user(u):
    return {k: v for k, v in u.items() if k != "password_hash"}
