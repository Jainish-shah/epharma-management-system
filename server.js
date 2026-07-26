const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { db, hashPassword, verifyPassword } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '3mb' })); // prescriptions upload as base64 data URLs
app.use(express.static(path.join(__dirname, 'public')));

// ---------- validation helpers (Phase 2) ----------
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isPhone = (s) => s == null || s === '' || /^[0-9+\-\s]{7,15}$/.test(s);
const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;
const nonNegNum = (n) => n != null && n !== '' && !Number.isNaN(Number(n)) && Number(n) >= 0;
const genOtp = () => String(crypto.randomInt(100000, 1000000)); // 6-digit

// ---------- helpers ----------
const publicUser = (u) => {
  const { password_hash, ...rest } = u;
  return rest;
};

const notify = (userId, message) =>
  db.prepare('INSERT INTO notifications (user_id, message) VALUES (?, ?)').run(userId, message);

const notifyAdmins = (message) => {
  for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin'").all()) notify(a.id, message);
};

// auth middleware: auth() = any logged-in user, auth('doctor','admin') = role-restricted
function auth(...roles) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const user = db
      .prepare('SELECT u.* FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?')
      .get(token);
    if (!user) return res.status(401).json({ error: 'Please log in' });
    if (roles.length && !roles.includes(user.role)) return res.status(403).json({ error: 'Not allowed for your role' });
    req.user = user;
    next();
  };
}

function issueToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO tokens (token, user_id) VALUES (?, ?)').run(token, userId);
  return token;
}

// ---------- auth ----------

// Phase 2: send a one-time password to the patient's email/mobile before they can register.
// NOTE: demo returns the code directly (and logs it); wire a real SMS/email gateway
// (Twilio / AWS SES) in Phase 3 and drop `devOtp` from the response.
app.post('/api/register/send-otp', (req, res) => {
  const { email } = req.body;
  if (!isEmail(email)) return res.status(400).json({ error: 'A valid email is required' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(400).json({ error: 'Email already registered' });
  }
  const code = genOtp();
  db.prepare(`INSERT INTO otps (email, code, created_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(email) DO UPDATE SET code = excluded.code, created_at = excluded.created_at`).run(email, code);
  console.log(`[OTP] ${email} -> ${code}`);
  res.json({ otpSent: true, devOtp: process.env.NODE_ENV === 'production' ? undefined : code });
});

app.post('/api/register', (req, res) => {
  const b = req.body;

  // ---- input validation (Phase 2 hardening) ----
  if (!['patient', 'doctor', 'pharmacy'].includes(b.role)) return res.status(400).json({ error: 'Invalid role' });
  if (!nonEmpty(b.name)) return res.status(400).json({ error: 'Name is required' });
  if (!isEmail(b.email)) return res.status(400).json({ error: 'A valid email is required' });
  if (!nonEmpty(b.password) || b.password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!isPhone(b.phone)) return res.status(400).json({ error: 'Phone number looks invalid' });
  if (b.role === 'doctor' && (!nonEmpty(b.qualification) || !nonEmpty(b.specialization))) {
    return res.status(400).json({ error: 'Doctors must provide qualification and specialization' });
  }
  if (b.role === 'pharmacy' && (!nonEmpty(b.store_name) || !nonEmpty(b.license_no))) {
    return res.status(400).json({ error: 'Pharmacies must provide store name and drug license number' });
  }
  if (b.fee != null && b.fee !== '' && !nonNegNum(b.fee)) return res.status(400).json({ error: 'Fee must be a non-negative number' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(b.email)) return res.status(400).json({ error: 'Email already registered' });

  // ---- OTP verification for patients (email/mobile) ----
  if (b.role === 'patient') {
    const row = db.prepare('SELECT code FROM otps WHERE email = ?').get(b.email);
    if (!row || row.code !== String(b.otp || '')) {
      return res.status(400).json({ error: 'Invalid or missing OTP — please verify your email/mobile first' });
    }
  }

  const status = b.role === 'patient' ? 'approved' : 'pending'; // doctors & pharmacies need admin approval
  const documents = b.documents && typeof b.documents === 'object' ? JSON.stringify(b.documents) : null;
  const info = db
    .prepare(`INSERT INTO users (role, name, email, phone, password_hash, status, specialization,
        qualification, fee, availability, store_name, license_no, gstin, address, documents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      b.role, b.name.trim(), b.email, b.phone || null, hashPassword(b.password), status,
      b.specialization || null, b.qualification || null, b.fee || null, b.availability || null,
      b.store_name || null, b.license_no || null, b.gstin || null, b.address || null, documents
    );

  db.prepare('DELETE FROM otps WHERE email = ?').run(b.email); // consume OTP
  if (status === 'pending') notifyAdmins(`New ${b.role} registration awaiting approval: ${b.name}`);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.json({ token: issueToken(user.id), user: publicUser(user) });
});

// Phase 2: upload/replace verification documents (doctor degree & license, pharmacy drug license & GSTIN proof).
app.post('/api/me/documents', auth('doctor', 'pharmacy'), (req, res) => {
  const { documents } = req.body;
  if (!documents || typeof documents !== 'object' || !Object.keys(documents).length) {
    return res.status(400).json({ error: 'No documents provided' });
  }
  db.prepare('UPDATE users SET documents = ? WHERE id = ?').run(JSON.stringify(documents), req.user.id);
  notifyAdmins(`${req.user.name} (${req.user.role}) uploaded verification documents`);
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email || '');
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  res.json({ token: issueToken(user.id), user: publicUser(user) });
});

app.post('/api/logout', auth(), (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  db.prepare('DELETE FROM tokens WHERE token = ?').run(token);
  res.json({ ok: true });
});

app.get('/api/me', auth(), (req, res) => res.json(publicUser(req.user)));

app.patch('/api/me', auth(), (req, res) => {
  const allowed = ['name', 'phone', 'address', 'availability', 'fee', 'specialization', 'qualification'];
  for (const key of allowed) {
    if (key in req.body) db.prepare(`UPDATE users SET ${key} = ? WHERE id = ?`).run(req.body[key], req.user.id);
  }
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
});

// ---------- public catalog ----------
app.get('/api/medicines', (req, res) => {
  const search = `%${req.query.search || ''}%`;
  const rows = db
    .prepare(`SELECT m.*, u.store_name FROM medicines m
      JOIN users u ON u.id = m.pharmacy_id AND u.status = 'approved'
      WHERE m.name LIKE ? OR m.category LIKE ? ORDER BY m.name`)
    .all(search, search);
  res.json(rows);
});

app.get('/api/doctors', (req, res) => {
  const search = `%${req.query.search || ''}%`;
  const rows = db
    .prepare(`SELECT id, name, specialization, qualification, fee, availability FROM users
      WHERE role = 'doctor' AND status = 'approved' AND (name LIKE ? OR specialization LIKE ?)
      ORDER BY name`)
    .all(search, search);
  res.json(rows);
});

// ---------- pharmacy inventory ----------
app.post('/api/medicines', auth('pharmacy'), (req, res) => {
  const { name, category, price, stock } = req.body;
  if (!nonEmpty(name) || !nonEmpty(category)) return res.status(400).json({ error: 'Name and category are required' });
  if (!nonNegNum(price)) return res.status(400).json({ error: 'Price must be a non-negative number' });
  if (stock != null && stock !== '' && !nonNegNum(stock)) return res.status(400).json({ error: 'Stock must be a non-negative number' });
  const info = db
    .prepare('INSERT INTO medicines (pharmacy_id, name, category, price, stock) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, name, category, Number(price), Number(stock) || 0);
  res.json(db.prepare('SELECT * FROM medicines WHERE id = ?').get(info.lastInsertRowid));
});

app.patch('/api/medicines/:id', auth('pharmacy'), (req, res) => {
  const med = db.prepare('SELECT * FROM medicines WHERE id = ? AND pharmacy_id = ?').get(req.params.id, req.user.id);
  if (!med) return res.status(404).json({ error: 'Medicine not found' });
  const { name, category, price, stock } = { ...med, ...req.body };
  db.prepare('UPDATE medicines SET name = ?, category = ?, price = ?, stock = ? WHERE id = ?')
    .run(name, category, Number(price), Number(stock), med.id);
  res.json(db.prepare('SELECT * FROM medicines WHERE id = ?').get(med.id));
});

app.delete('/api/medicines/:id', auth('pharmacy'), (req, res) => {
  db.prepare('DELETE FROM medicines WHERE id = ? AND pharmacy_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.get('/api/my-medicines', auth('pharmacy'), (req, res) => {
  res.json(db.prepare('SELECT * FROM medicines WHERE pharmacy_id = ? ORDER BY name').all(req.user.id));
});

// ---------- orders ----------
const NEXT_STATUS = { pending: 'preparing', preparing: null, shipped: 'delivered', ready: 'picked_up' };

app.post('/api/orders', auth('patient'), (req, res) => {
  const { items, type, address, prescription } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Cart is empty' });
  if (type === 'delivery' && !address) return res.status(400).json({ error: 'Delivery address is required' });

  // node:sqlite has no transaction helper — manual BEGIN/COMMIT
  const placeOrder = () => {
    let total = 0;
    let pharmacyId = null;
    const lines = [];
    for (const it of items) {
      const med = db.prepare('SELECT * FROM medicines WHERE id = ?').get(it.medicine_id);
      if (!med) throw new Error('Medicine not found');
      if (pharmacyId && pharmacyId !== med.pharmacy_id) throw new Error('All items must be from one pharmacy');
      pharmacyId = med.pharmacy_id;
      const qty = Math.max(1, Number(it.qty) || 1);
      if (med.stock < qty) throw new Error(`Only ${med.stock} left of ${med.name}`);
      db.prepare('UPDATE medicines SET stock = stock - ? WHERE id = ?').run(qty, med.id);
      total += med.price * qty;
      lines.push({ med, qty });
    }

    let prescriptionId = null;
    if (prescription) {
      prescriptionId = db
        .prepare("INSERT INTO prescriptions (patient_id, kind, content) VALUES (?, 'uploaded', ?)")
        .run(req.user.id, prescription).lastInsertRowid;
    }

    const orderId = db
      .prepare('INSERT INTO orders (patient_id, pharmacy_id, type, address, total, prescription_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.id, pharmacyId, type === 'pickup' ? 'pickup' : 'delivery', address || null, total, prescriptionId)
      .lastInsertRowid;

    const insertItem = db.prepare('INSERT INTO order_items (order_id, medicine_id, name, price, qty) VALUES (?, ?, ?, ?, ?)');
    for (const { med, qty } of lines) insertItem.run(orderId, med.id, med.name, med.price, qty);

    notify(pharmacyId, `New order #${orderId} received (₹${total.toFixed(2)})`);
    return orderId;
  };

  db.exec('BEGIN');
  try {
    const orderId = placeOrder();
    db.exec('COMMIT');
    res.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/orders', auth(), (req, res) => {
  let where = '';
  const params = [];
  if (req.user.role === 'patient') { where = 'WHERE o.patient_id = ?'; params.push(req.user.id); }
  else if (req.user.role === 'pharmacy') { where = 'WHERE o.pharmacy_id = ?'; params.push(req.user.id); }
  else if (req.user.role !== 'admin') return res.status(403).json({ error: 'Not allowed for your role' });

  const orders = db
    .prepare(`SELECT o.*, p.name AS patient_name, ph.store_name FROM orders o
      JOIN users p ON p.id = o.patient_id
      JOIN users ph ON ph.id = o.pharmacy_id
      ${where} ORDER BY o.id DESC`)
    .all(...params);
  const itemsFor = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  const rxFor = db.prepare('SELECT content FROM prescriptions WHERE id = ?');
  for (const o of orders) {
    o.items = itemsFor.all(o.id);
    o.prescription = o.prescription_id ? (rxFor.get(o.prescription_id) || {}).content : null;
  }
  res.json(orders);
});

app.patch('/api/orders/:id', auth('pharmacy'), (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND pharmacy_id = ?').get(req.params.id, req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  // preparing branches by fulfilment type: delivery → shipped, pickup → ready
  let next = NEXT_STATUS[order.status];
  if (order.status === 'preparing') next = order.type === 'delivery' ? 'shipped' : 'ready';
  if (!next) return res.status(400).json({ error: 'Order is already complete' });

  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(next, order.id);
  notify(order.patient_id, `Order #${order.id} is now ${next.replace('_', ' ')}`);
  res.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id));
});

// ---------- appointments ----------
app.post('/api/appointments', auth('patient'), (req, res) => {
  const { doctor_id, slot } = req.body;
  const doctor = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'doctor' AND status = 'approved'").get(doctor_id);
  if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
  if (!slot) return res.status(400).json({ error: 'Please pick a slot' });
  const info = db
    .prepare('INSERT INTO appointments (patient_id, doctor_id, slot) VALUES (?, ?, ?)')
    .run(req.user.id, doctor.id, slot);
  notify(doctor.id, `New appointment request from ${req.user.name} — ${slot}`);
  res.json(db.prepare('SELECT * FROM appointments WHERE id = ?').get(info.lastInsertRowid));
});

app.get('/api/appointments', auth(), (req, res) => {
  let where = '';
  const params = [];
  if (req.user.role === 'patient') { where = 'WHERE a.patient_id = ?'; params.push(req.user.id); }
  else if (req.user.role === 'doctor') { where = 'WHERE a.doctor_id = ?'; params.push(req.user.id); }
  else if (req.user.role !== 'admin') return res.status(403).json({ error: 'Not allowed for your role' });
  res.json(
    db.prepare(`SELECT a.*, p.name AS patient_name, d.name AS doctor_name, d.specialization, d.fee
      FROM appointments a
      JOIN users p ON p.id = a.patient_id
      JOIN users d ON d.id = a.doctor_id
      ${where} ORDER BY a.id DESC`).all(...params)
  );
});

app.patch('/api/appointments/:id', auth('doctor'), (req, res) => {
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ? AND doctor_id = ?').get(req.params.id, req.user.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  const { status } = req.body;
  if (!['confirmed', 'rejected', 'completed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, appt.id);
  notify(appt.patient_id, `Appointment with ${req.user.name} (${appt.slot}) was ${status}`);
  res.json(db.prepare('SELECT * FROM appointments WHERE id = ?').get(appt.id));
});

// ---------- prescriptions ----------
app.post('/api/prescriptions', auth('doctor'), (req, res) => {
  const { appointment_id, content } = req.body;
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ? AND doctor_id = ?').get(appointment_id, req.user.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  if (!content) return res.status(400).json({ error: 'Prescription text is required' });
  const info = db
    .prepare("INSERT INTO prescriptions (patient_id, doctor_id, appointment_id, kind, content) VALUES (?, ?, ?, 'eprescription', ?)")
    .run(appt.patient_id, req.user.id, appt.id, content);
  db.prepare("UPDATE appointments SET status = 'completed' WHERE id = ?").run(appt.id);
  notify(appt.patient_id, `e-Prescription uploaded by ${req.user.name}`);
  res.json(db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(info.lastInsertRowid));
});

app.post('/api/prescriptions/upload', auth('patient'), (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'No file received' });
  const info = db
    .prepare("INSERT INTO prescriptions (patient_id, kind, content) VALUES (?, 'uploaded', ?)")
    .run(req.user.id, content);
  res.json(db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(info.lastInsertRowid));
});

app.get('/api/prescriptions', auth(), (req, res) => {
  let where;
  if (req.user.role === 'patient') where = 'p.patient_id = ?';
  else if (req.user.role === 'doctor') where = 'p.doctor_id = ?';
  else return res.status(403).json({ error: 'Not allowed for your role' });
  res.json(
    db.prepare(`SELECT p.*, pat.name AS patient_name, doc.name AS doctor_name FROM prescriptions p
      JOIN users pat ON pat.id = p.patient_id
      LEFT JOIN users doc ON doc.id = p.doctor_id
      WHERE ${where} ORDER BY p.id DESC`).all(req.user.id)
  );
});

// ---------- notifications ----------
app.get('/api/notifications', auth(), (req, res) => {
  res.json(db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(req.user.id));
});

app.post('/api/notifications/read', auth(), (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

// ---------- doctor earnings ----------
app.get('/api/earnings', auth('doctor'), (req, res) => {
  const row = db
    .prepare("SELECT COUNT(*) AS consultations FROM appointments WHERE doctor_id = ? AND status = 'completed'")
    .get(req.user.id);
  res.json({ consultations: row.consultations, total: row.consultations * (req.user.fee || 0) });
});

// ---------- admin ----------
app.get('/api/admin/users', auth('admin'), (req, res) => {
  let sql = "SELECT * FROM users WHERE role != 'admin'";
  const params = [];
  if (req.query.status) { sql += ' AND status = ?'; params.push(req.query.status); }
  if (req.query.role) { sql += ' AND role = ?'; params.push(req.query.role); }
  res.json(db.prepare(sql + ' ORDER BY id DESC').all(...params).map(publicUser));
});

app.patch('/api/admin/users/:id', auth('admin'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { status } = req.body;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, user.id);
  notify(user.id, `Your ${user.role} account was ${status} by the admin`);
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)));
});

app.get('/api/admin/stats', auth('admin'), (req, res) => {
  const count = (sql, ...p) => db.prepare(sql).get(...p).c;
  res.json({
    patients: count("SELECT COUNT(*) AS c FROM users WHERE role = 'patient'"),
    doctors: count("SELECT COUNT(*) AS c FROM users WHERE role = 'doctor' AND status = 'approved'"),
    pharmacies: count("SELECT COUNT(*) AS c FROM users WHERE role = 'pharmacy' AND status = 'approved'"),
    pending_approvals: count("SELECT COUNT(*) AS c FROM users WHERE status = 'pending'"),
    orders: count('SELECT COUNT(*) AS c FROM orders'),
    revenue: db.prepare('SELECT COALESCE(SUM(total), 0) AS s FROM orders').get().s,
    appointments: count('SELECT COUNT(*) AS c FROM appointments'),
  });
});

// ---------- error handling (Phase 2) ----------
// Unknown API routes return JSON, not the SPA's index.html.
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found' }));

// Central error handler: turns body-parse/oversize failures and uncaught errors into clean JSON.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON in request body' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload too large (3 MB limit)' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`E-Pharma running at http://localhost:${PORT}`);
  console.log('Demo logins:');
  console.log('  admin@epharma.com / admin123   (Admin)');
  console.log('  asha@epharma.com  / doctor123  (Doctor, approved)');
  console.log('  store@medplus.com / pharma123  (Pharmacy, approved)');
  console.log('  priya@gmail.com   / patient123 (Patient)');
});
