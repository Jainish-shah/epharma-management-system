const { DatabaseSync } = require('node:sqlite'); // built-in, Node >= 22.5
const crypto = require('crypto');
const path = require('path');

const db = new DatabaseSync(process.env.EPHARMA_DB || path.join(__dirname, 'epharma.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('patient','doctor','pharmacy','admin')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved','rejected')),
  specialization TEXT,
  qualification TEXT,
  fee INTEGER,
  availability TEXT,
  store_name TEXT,
  license_no TEXT,
  gstin TEXT,
  address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS medicines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price REAL NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  pharmacy_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending',
  type TEXT NOT NULL DEFAULT 'delivery' CHECK (type IN ('delivery','pickup')),
  address TEXT,
  total REAL NOT NULL,
  prescription_id INTEGER REFERENCES prescriptions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  name TEXT NOT NULL,
  price REAL NOT NULL,
  qty INTEGER NOT NULL
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
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phase 2: one-time passwords for patient registration (verified against email/mobile before account creation)
CREATE TABLE IF NOT EXISTS otps (
  email TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phase 3: payment intents (Razorpay-shaped). One row per checkout attempt; linked to an order once paid.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_order_id TEXT NOT NULL UNIQUE,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,            -- in paise, Razorpay convention
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed')),
  order_id INTEGER REFERENCES orders(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phase 3: teleconsultation chat messages, scoped to a confirmed appointment.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phase 3: refill reminders, one per ordered medicine, materialised into notifications when due.
CREATE TABLE IF NOT EXISTS refill_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  medicine_name TEXT NOT NULL,
  due_date TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0
);
`);

// Phase 2 migration: add verification-documents column to existing databases (JSON of {label: dataURL}).
// New DBs get it here too; guard makes it a no-op when already present.
if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === 'documents')) {
  db.exec('ALTER TABLE users ADD COLUMN documents TEXT');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), candidate);
}

// ---- Seed demo data on first run ----
if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0) {
  const defaults = {
    phone: null, specialization: null, qualification: null, fee: null,
    availability: null, store_name: null, license_no: null, gstin: null, address: null,
  };
  const insertUser = db.prepare(`
    INSERT INTO users (role, name, email, phone, password_hash, status, specialization,
      qualification, fee, availability, store_name, license_no, gstin, address)
    VALUES (@role, @name, @email, @phone, @password_hash, @status, @specialization,
      @qualification, @fee, @availability, @store_name, @license_no, @gstin, @address)
  `);
  const addUser = ({ password, ...u }) =>
    insertUser.run({ ...defaults, ...u, password_hash: hashPassword(password) }).lastInsertRowid;

  addUser({ role: 'admin', name: 'System Admin', email: 'admin@epharma.com', password: 'admin123', status: 'approved' });

  addUser({
    role: 'doctor', name: 'Dr. Asha Mehta', email: 'asha@epharma.com', password: 'doctor123',
    status: 'approved', specialization: 'Cardiology', qualification: 'MBBS, MD (Cardiology)',
    fee: 600, availability: 'Mon 10:00, Mon 11:00, Wed 15:00, Fri 10:00', phone: '9876500001',
  });
  addUser({
    role: 'doctor', name: 'Dr. Rohan Iyer', email: 'rohan@epharma.com', password: 'doctor123',
    status: 'approved', specialization: 'Dermatology', qualification: 'MBBS, MD (Dermatology)',
    fee: 500, availability: 'Tue 09:00, Tue 10:00, Thu 14:00, Sat 11:00', phone: '9876500002',
  });
  addUser({
    role: 'doctor', name: 'Dr. Kunal Shah', email: 'kunal@epharma.com', password: 'doctor123',
    status: 'pending', specialization: 'Orthopedics', qualification: 'MBBS, MS (Ortho)',
    fee: 700, availability: 'Mon 16:00, Wed 16:00', phone: '9876500003',
  });

  const medplus = addUser({
    role: 'pharmacy', name: 'Ramesh Gupta', email: 'store@medplus.com', password: 'pharma123',
    status: 'approved', store_name: 'MedPlus Pharmacy', license_no: 'DL-MH-12345',
    gstin: '27ABCDE1234F1Z5', address: 'Shop 4, FC Road, Pune', phone: '9876500010',
  });
  addUser({
    role: 'pharmacy', name: 'Sunita Rao', email: 'store@healthkart.com', password: 'pharma123',
    status: 'pending', store_name: 'HealthKart Chemist', license_no: 'DL-MH-67890',
    gstin: '27FGHIJ5678K2Z9', address: 'MG Road, Pune', phone: '9876500011',
  });

  addUser({
    role: 'patient', name: 'Priya Sharma', email: 'priya@gmail.com', password: 'patient123',
    status: 'approved', phone: '9876500020', address: '12 Rose Villa, Baner, Pune',
  });

  // Pending doctor & pharmacy ship with demo verification documents so the admin approval flow is demoable.
  const placeholderDoc = (text) =>
    'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='340' height='190'><rect width='100%' height='100%' fill='#e0f2f1'/><text x='18' y='100' font-family='sans-serif' font-size='16' fill='#0f766e'>${text}</text></svg>`);
  const setDocs = db.prepare('UPDATE users SET documents = ? WHERE email = ?');
  setDocs.run(JSON.stringify({
    'Degree certificate': placeholderDoc('MBBS Degree — Dr. Kunal Shah'),
    'Medical license': placeholderDoc('Medical License MH-ORTHO-2231'),
  }), 'kunal@epharma.com');
  setDocs.run(JSON.stringify({
    'Drug license': placeholderDoc('Drug License DL-MH-67890'),
    'GSTIN proof': placeholderDoc('GSTIN 27FGHIJ5678K2Z9'),
  }), 'store@healthkart.com');

  const insertMed = db.prepare('INSERT INTO medicines (pharmacy_id, name, category, price, stock) VALUES (?, ?, ?, ?, ?)');
  const meds = [
    ['Paracetamol 500mg (10 tabs)', 'Pain Relief', 30, 200],
    ['Ibuprofen 400mg (10 tabs)', 'Pain Relief', 45, 150],
    ['Amoxicillin 250mg (10 caps)', 'Antibiotics', 80, 90],
    ['Azithromycin 500mg (3 tabs)', 'Antibiotics', 110, 70],
    ['Cetirizine 10mg (10 tabs)', 'Allergy', 25, 300],
    ['Metformin 500mg (20 tabs)', 'Diabetes', 60, 120],
    ['Insulin Glargine 100IU', 'Diabetes', 850, 40],
    ['Amlodipine 5mg (15 tabs)', 'Blood Pressure', 55, 100],
    ['Omeprazole 20mg (15 caps)', 'Digestive', 70, 110],
    ['Cough Syrup 100ml', 'Cold & Flu', 95, 80],
    ['Vitamin D3 60K (4 caps)', 'Supplements', 130, 140],
    ['ORS Sachets (pack of 5)', 'Hydration', 40, 250],
  ];
  for (const m of meds) insertMed.run(medplus, ...m);
}

module.exports = { db, hashPassword, verifyPassword };
