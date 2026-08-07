const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { db, hashPassword, verifyPassword } = require('./db');
const payments = require('./payments');
const { TOPICS, publish, subscribe, initKafka } = require('./events');

const app = express();
const PORT = process.env.PORT || 3000;
const REFILL_DAYS = Number(process.env.REFILL_DAYS || 30); // days after an order to remind for a refill

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

// Notifications are now an event, not a direct DB write: publishers emit to the NOTIFICATIONS topic
// and the notification service (subscriber below) persists them. Decouples every producer from storage
// and lets other services (email/SMS) subscribe to the same stream.
const notify = (userId, message) => publish(TOPICS.NOTIFICATIONS, { userId, message });

const notifyAdmins = (message) => {
  for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin'").all()) notify(a.id, message);
};

// ---- event consumers (the "services" fed by the stream) ----
// Notification service: persist every notification event.
subscribe(TOPICS.NOTIFICATIONS, ({ userId, message }) => {
  db.prepare('INSERT INTO notifications (user_id, message) VALUES (?, ?)').run(userId, message);
});

// Payment service: on a successful payment, issue the patient's receipt notification.
// (A real deployment could also fan this out to email/accounting consumers on the same topic.)
subscribe(TOPICS.PAYMENTS, ({ orderId, patientId, amount }) => {
  console.log(`[payments] order #${orderId} paid: ₹${(amount / 100).toFixed(2)}`);
  notify(patientId, `Payment received: ₹${(amount / 100).toFixed(2)} for order #${orderId}`);
});

// Order/analytics service: a second consumer on the stream, demonstrating fan-out.
subscribe(TOPICS.ORDERS, ({ orderId, pharmacyId, total }) => {
  console.log(`[orders] order #${orderId} placed with pharmacy ${pharmacyId} (₹${total.toFixed(2)})`);
});

// Phase 4: notification delivery gateway — a SECOND consumer on the notifications topic that
// delivers the message over email/SMS (fan-out: one event is both persisted and delivered).
// ponytail: mock delivery = log line. Set NOTIFY_CHANNELS=email,sms and swap the send bodies for
// Twilio/AWS SES to go live — no other code changes.
const NOTIFY_CHANNELS = (process.env.NOTIFY_CHANNELS || 'log').split(',');
subscribe(TOPICS.NOTIFICATIONS, ({ userId, message }) => {
  const u = db.prepare('SELECT email, phone FROM users WHERE id = ?').get(userId);
  if (!u) return;
  if (NOTIFY_CHANNELS.some((c) => c === 'email' || c === 'log')) console.log(`[email -> ${u.email}] ${message}`);
  if (u.phone && NOTIFY_CHANNELS.some((c) => c === 'sms' || c === 'log')) console.log(`[sms -> ${u.phone}] ${message}`);
});

// Phase 3: turn any due, un-notified refill reminders into notifications. Checked on-access
// (when the patient fetches notifications) so no background scheduler is needed for the demo.
// NOTE: a production system would run this from a cron/worker, not lazily per request.
const runDueRefills = (patientId) => {
  const due = db
    .prepare("SELECT * FROM refill_reminders WHERE patient_id = ? AND notified = 0 AND due_date <= datetime('now')")
    .all(patientId);
  for (const r of due) {
    notify(patientId, `Refill reminder: it may be time to reorder ${r.medicine_name}`);
    db.prepare('UPDATE refill_reminders SET notified = 1 WHERE id = ?').run(r.id);
  }
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

// ---------- public config ----------
// Lets the client show the active payment provider without hard-coding it.
app.get('/api/config', (req, res) => res.json({ paymentProvider: payments.provider, mock: payments.IS_MOCK }));

// Phase 4: controlled lists (categories / specialties) — public read for form suggestions.
app.get('/api/taxonomy', (req, res) => {
  const rows = req.query.type
    ? db.prepare('SELECT * FROM taxonomy WHERE type = ? ORDER BY name').all(req.query.type)
    : db.prepare('SELECT * FROM taxonomy ORDER BY type, name').all();
  res.json(rows);
});

// Phase 4: CMS pages — public read (list + single page).
app.get('/api/cms', (req, res) => res.json(db.prepare('SELECT slug, title FROM cms_pages ORDER BY slug').all()));
app.get('/api/cms/:slug', (req, res) => {
  const page = db.prepare('SELECT * FROM cms_pages WHERE slug = ?').get(req.params.slug);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  res.json(page);
});

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

// ---------- payments (Phase 3) ----------

// Price a cart without touching stock: returns { total, pharmacyId } or throws on a bad cart.
function priceCart(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('Cart is empty');
  let total = 0;
  let pharmacyId = null;
  for (const it of items) {
    const med = db.prepare('SELECT * FROM medicines WHERE id = ?').get(it.medicine_id);
    if (!med) throw new Error('Medicine not found');
    if (pharmacyId && pharmacyId !== med.pharmacy_id) throw new Error('All items must be from one pharmacy');
    pharmacyId = med.pharmacy_id;
    const qty = Math.max(1, Number(it.qty) || 1);
    if (med.stock < qty) throw new Error(`Only ${med.stock} left of ${med.name}`);
    total += med.price * qty;
  }
  return { total, pharmacyId };
}

// Step 1 of checkout: create a payment intent for the cart. Returns the provider order id + amount.
// On the mock gateway it also returns `demoCheckout` (the {order_id, payment_id, signature} triple a
// real Razorpay widget would hand back) so the flow completes without live keys.
app.post('/api/payments/create', auth('patient'), (req, res) => {
  try {
    const { total } = priceCart(req.body.items);
    const amount = Math.round(total * 100); // smallest currency unit
    const intent = payments.createIntent(amount);
    db.prepare('INSERT INTO payments (provider_order_id, patient_id, amount) VALUES (?, ?, ?)')
      .run(intent.id, req.user.id, amount);
    res.json({
      provider: payments.provider,
      providerOrderId: intent.id,
      amount,
      currency: intent.currency,
      key: intent.key,
      clientSecret: intent.clientSecret,
      demoCheckout: payments.IS_MOCK ? payments.mockCheckout(intent.id) : undefined,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- orders ----------
const NEXT_STATUS = { pending: 'preparing', preparing: null, shipped: 'delivered', ready: 'picked_up' };

app.post('/api/orders', auth('patient'), (req, res) => {
  const { items, type, address, prescription, payment } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Cart is empty' });
  if (type === 'delivery' && !address) return res.status(400).json({ error: 'Delivery address is required' });

  // Phase 3: verify the payment (provider-neutral) before creating the order.
  const providerOrderId = payment && payments.orderIdOf(payment);
  if (!providerOrderId) return res.status(402).json({ error: 'Payment required' });
  const pay = db.prepare('SELECT * FROM payments WHERE provider_order_id = ? AND patient_id = ?')
    .get(providerOrderId, req.user.id);
  if (!pay || pay.status !== 'created') return res.status(402).json({ error: 'Unknown or already-used payment' });
  if (!payments.verify(providerOrderId, payment)) {
    return res.status(402).json({ error: 'Payment verification failed' });
  }

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

    // Guard against tampering: paid amount must match the recomputed cart total.
    if (Math.round(total * 100) !== pay.amount) throw new Error('Paid amount does not match cart total');

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
    const insertRefill = db.prepare(
      "INSERT INTO refill_reminders (patient_id, medicine_name, due_date) VALUES (?, ?, datetime('now', ?))");
    for (const { med, qty } of lines) {
      insertItem.run(orderId, med.id, med.name, med.price, qty);
      insertRefill.run(req.user.id, med.name, `+${REFILL_DAYS} days`); // Phase 3: schedule refill reminder
    }

    db.prepare("UPDATE payments SET status = 'paid', order_id = ? WHERE id = ?").run(orderId, pay.id);
    // Emit domain events; the notification/payment services (subscribers) react to these.
    publish(TOPICS.ORDERS, { orderId, pharmacyId, patientId: req.user.id, total });
    publish(TOPICS.PAYMENTS, { orderId, patientId: req.user.id, amount: pay.amount });
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

// ---------- teleconsultation: chat + video (Phase 3) ----------

// Return the appointment only if this user is a party to it (its patient or its doctor).
function apptForUser(id, user) {
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
  if (!appt) return null;
  if (user.role === 'patient' && appt.patient_id === user.id) return appt;
  if (user.role === 'doctor' && appt.doctor_id === user.id) return appt;
  return null;
}

const CONSULT_SECRET = process.env.CONSULT_SECRET || 'epharma-consult-secret';

app.get('/api/appointments/:id/messages', auth('patient', 'doctor'), (req, res) => {
  const appt = apptForUser(req.params.id, req.user);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  res.json(
    db.prepare(`SELECT m.*, u.name AS sender_name, u.role AS sender_role FROM messages m
      JOIN users u ON u.id = m.sender_id WHERE m.appointment_id = ? ORDER BY m.id`).all(appt.id)
  );
});

app.post('/api/appointments/:id/messages', auth('patient', 'doctor'), (req, res) => {
  const appt = apptForUser(req.params.id, req.user);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  if (!['confirmed', 'completed'].includes(appt.status)) {
    return res.status(400).json({ error: 'Consultation opens once the appointment is confirmed' });
  }
  if (!nonEmpty(req.body.body)) return res.status(400).json({ error: 'Message cannot be empty' });
  const info = db.prepare('INSERT INTO messages (appointment_id, sender_id, body) VALUES (?, ?, ?)')
    .run(appt.id, req.user.id, req.body.body.trim());
  const other = req.user.id === appt.patient_id ? appt.doctor_id : appt.patient_id;
  notify(other, `New consultation message from ${req.user.name}`);
  res.json(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
});

// Video room: a deterministic, unguessable Jitsi room per appointment (both parties derive the same name).
// NOTE: uses public meet.jit.si — no custom WebRTC signaling/TURN server for this phase.
app.get('/api/appointments/:id/room', auth('patient', 'doctor'), (req, res) => {
  const appt = apptForUser(req.params.id, req.user);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  if (!['confirmed', 'completed'].includes(appt.status)) {
    return res.status(400).json({ error: 'Video call opens once the appointment is confirmed' });
  }
  const tokenPart = crypto.createHash('sha256').update(CONSULT_SECRET + ':' + appt.id).digest('hex').slice(0, 12);
  const room = `epharma-appt-${appt.id}-${tokenPart}`;
  res.json({ room, url: `https://meet.jit.si/${room}` });
});

// ---------- refill reminders (Phase 3) ----------
app.get('/api/refills', auth('patient'), (req, res) => {
  res.json(
    db.prepare('SELECT * FROM refill_reminders WHERE patient_id = ? ORDER BY due_date').all(req.user.id)
  );
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
  if (req.user.role === 'patient') runDueRefills(req.user.id); // Phase 3: surface any due refill reminders
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

// Phase 4: reporting — aggregation queries for the admin dashboard (revenue, orders, consultations).
app.get('/api/admin/reports', auth('admin'), (req, res) => {
  const all = (sql) => db.prepare(sql).all();
  res.json({
    revenue_by_day: all("SELECT substr(created_at,1,10) AS day, ROUND(SUM(total),2) AS revenue, COUNT(*) AS orders FROM orders GROUP BY day ORDER BY day"),
    orders_by_status: all('SELECT status, COUNT(*) AS count FROM orders GROUP BY status'),
    top_medicines: all('SELECT name, SUM(qty) AS units, ROUND(SUM(price*qty),2) AS revenue FROM order_items GROUP BY name ORDER BY units DESC LIMIT 5'),
    revenue_by_pharmacy: all('SELECT u.store_name AS pharmacy, ROUND(SUM(o.total),2) AS revenue, COUNT(*) AS orders FROM orders o JOIN users u ON u.id=o.pharmacy_id GROUP BY o.pharmacy_id ORDER BY revenue DESC'),
    appointments_by_status: all('SELECT status, COUNT(*) AS count FROM appointments GROUP BY status'),
    consultations: db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(d.fee),0) AS revenue FROM appointments a JOIN users d ON d.id=a.doctor_id WHERE a.status='completed'").get(),
  });
});

// Phase 4: taxonomy management (admin add/remove categories & specialties).
app.post('/api/admin/taxonomy', auth('admin'), (req, res) => {
  const { type, name } = req.body;
  if (!['category', 'specialty'].includes(type) || !nonEmpty(name)) {
    return res.status(400).json({ error: 'A type (category/specialty) and name are required' });
  }
  db.prepare('INSERT OR IGNORE INTO taxonomy (type, name) VALUES (?, ?)').run(type, name.trim());
  res.json(db.prepare('SELECT * FROM taxonomy WHERE type = ? AND name = ?').get(type, name.trim()));
});

app.delete('/api/admin/taxonomy/:id', auth('admin'), (req, res) => {
  db.prepare('DELETE FROM taxonomy WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Phase 4: CMS editing (admin upsert of FAQ/Terms/Privacy pages).
app.put('/api/admin/cms/:slug', auth('admin'), (req, res) => {
  const { title, body } = req.body;
  if (!nonEmpty(title) || !nonEmpty(body)) return res.status(400).json({ error: 'Title and body are required' });
  db.prepare(`INSERT INTO cms_pages (slug, title, body, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET title = excluded.title, body = excluded.body, updated_at = excluded.updated_at`)
    .run(req.params.slug, title.trim(), body);
  res.json(db.prepare('SELECT * FROM cms_pages WHERE slug = ?').get(req.params.slug));
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
  console.log(`Payment provider: ${payments.provider}${payments.IS_MOCK ? ' (mock/sandbox)' : ''}`);
  initKafka().catch((e) => console.error('[events] Kafka init failed, using in-process bus:', e.message));
  console.log('Demo logins:');
  console.log('  admin@epharma.com / admin123   (Admin)');
  console.log('  asha@epharma.com  / doctor123  (Doctor, approved)');
  console.log('  store@medplus.com / pharma123  (Pharmacy, approved)');
  console.log('  priya@gmail.com   / patient123 (Patient)');
});
