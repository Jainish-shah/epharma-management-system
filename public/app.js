/* E-Pharma frontend — vanilla JS SPA, no build step */

let token = localStorage.getItem('token');
let user = JSON.parse(localStorage.getItem('user') || 'null');
let cart = []; // { medicine_id, name, price, qty, store_name }
let activeTab = null;

const $ = (sel) => document.querySelector(sel);
const app = $('#app');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (n) => '₹' + Number(n).toFixed(2);

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 3000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

// ---------- modal ----------
function openModal(html) {
  $('#modalRoot').innerHTML = `<div class="modal-overlay" onclick="if(event.target===this)closeModal()"><div class="modal">${html}</div></div>`;
}
function closeModal() { $('#modalRoot').innerHTML = ''; }

// ---------- navbar ----------
async function renderNav() {
  const right = $('#navRight');
  if (!user) {
    right.innerHTML = `<button class="btn secondary" onclick="showLogin()">Login</button>
      <button class="btn" onclick="showRegister()">Register</button>`;
    return;
  }
  let unread = 0;
  try {
    const notifs = await api('/api/notifications');
    unread = notifs.filter((n) => !n.read).length;
  } catch (e) { /* token may have expired */ }
  right.innerHTML = `
    <button class="bell" onclick="toggleNotifs()">🔔${unread ? `<span class="count">${unread}</span>` : ''}</button>
    <span class="nav-user">${esc(user.name)}</span>
    <span class="badge-role">${user.role}</span>
    <button class="btn secondary small" onclick="logout()">Logout</button>`;
}

async function toggleNotifs() {
  const existing = $('.notif-panel');
  if (existing) { existing.remove(); return; }
  const notifs = await api('/api/notifications');
  const panel = document.createElement('div');
  panel.className = 'notif-panel';
  panel.innerHTML = notifs.length
    ? notifs.map((n) => `<div class="notif-item ${n.read ? '' : 'unread'}">${esc(n.message)}<div class="time">${esc(n.created_at)}</div></div>`).join('')
    : '<div class="notif-item">No notifications yet</div>';
  document.body.appendChild(panel);
  await api('/api/notifications/read', { method: 'POST' });
  renderNav();
}

// ---------- auth ----------
function showLogin() {
  openModal(`
    <h2>Welcome back</h2>
    <div class="sub">Log in to E-Pharma</div>
    <label>Email</label><input id="loginEmail" type="email" placeholder="you@example.com" />
    <label>Password</label><input id="loginPass" type="password" />
    <div class="actions">
      <button class="btn secondary" onclick="closeModal()">Cancel</button>
      <button class="btn" onclick="doLogin()">Login</button>
    </div>
    <div class="demo-creds"><b>Demo accounts</b><br>
      admin@epharma.com / admin123<br>
      asha@epharma.com / doctor123<br>
      store@medplus.com / pharma123<br>
      priya@gmail.com / patient123
    </div>`);
}

async function doLogin() {
  try {
    const data = await api('/api/login', { method: 'POST', body: { email: $('#loginEmail').value.trim(), password: $('#loginPass').value } });
    setSession(data);
    toast(`Welcome, ${data.user.name}`);
  } catch (e) { toast(e.message, true); }
}

function showRegister(role = 'patient') {
  const extra = {
    // Patients verify their email/mobile with an OTP before the account is created (Phase 2).
    patient: `<label>Address</label><input id="regAddress" placeholder="Delivery address" />
      <label>Verify email / mobile (OTP)</label>
      <div style="display:flex;gap:8px">
        <input id="regOtp" placeholder="6-digit code" />
        <button class="btn secondary" type="button" style="white-space:nowrap" onclick="sendOtp()">Send OTP</button>
      </div>
      <div class="meta" id="otpHint" style="margin-top:4px"></div>`,
    doctor: `<label>Qualification</label><input id="regQualification" placeholder="MBBS, MD" />
      <label>Specialization</label><input id="regSpecialization" placeholder="Cardiology" />
      <label>Consultation fee (₹)</label><input id="regFee" type="number" placeholder="500" />
      <label>Availability slots (comma separated)</label><input id="regAvailability" placeholder="Mon 10:00, Wed 15:00" />
      <label>Upload degree certificate (image)</label><input id="docDegree" type="file" accept="image/*" />
      <label>Upload medical license (image)</label><input id="docLicense" type="file" accept="image/*" />`,
    pharmacy: `<label>Store name</label><input id="regStore" placeholder="MedPlus Pharmacy" />
      <label>Drug license no.</label><input id="regLicense" placeholder="DL-MH-12345" />
      <label>GSTIN</label><input id="regGstin" placeholder="27ABCDE1234F1Z5" />
      <label>Store address</label><input id="regAddress" placeholder="Shop address" />
      <label>Upload drug license (image)</label><input id="docDrugLicense" type="file" accept="image/*" />
      <label>Upload GSTIN proof (image)</label><input id="docGstinProof" type="file" accept="image/*" />`,
  }[role];

  openModal(`
    <h2>Create account</h2>
    <div class="sub">Doctors and pharmacies upload verification documents and need admin approval before going live.</div>
    <label>I am a</label>
    <select id="regRole" onchange="showRegister(this.value)">
      ${['patient', 'doctor', 'pharmacy'].map((r) => `<option value="${r}" ${r === role ? 'selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`).join('')}
    </select>
    <label>Full name</label><input id="regName" />
    <label>Email</label><input id="regEmail" type="email" />
    <label>Mobile</label><input id="regPhone" />
    <label>Password (min 6 chars)</label><input id="regPass" type="password" />
    ${extra}
    <div class="actions">
      <button class="btn secondary" onclick="closeModal()">Cancel</button>
      <button class="btn" onclick="doRegister()">Register</button>
    </div>`);
}

async function sendOtp() {
  try {
    const email = $('#regEmail').value.trim();
    const data = await api('/api/register/send-otp', { method: 'POST', body: { email } });
    // Demo mode returns the code so it can be shown; a real gateway would deliver it out-of-band.
    $('#otpHint').textContent = data.devOtp ? `Demo OTP sent: ${data.devOtp}` : 'OTP sent to your email/mobile.';
    toast('OTP sent');
  } catch (e) { toast(e.message, true); }
}

// Read the selected files of the given file-input ids into a { label: dataURL } object.
async function collectDocuments(map) {
  const docs = {};
  for (const [id, label] of Object.entries(map)) {
    const file = $(id)?.files[0];
    if (!file) continue;
    if (file.size > 2 * 1024 * 1024) throw new Error(`${label} must be under 2 MB`);
    docs[label] = await fileToDataUrl(file);
  }
  return docs;
}

async function doRegister() {
  const val = (id) => { const el = $(id); return el ? el.value.trim() : undefined; };
  const role = $('#regRole').value;
  try {
    let documents;
    if (role === 'doctor') documents = await collectDocuments({ '#docDegree': 'Degree certificate', '#docLicense': 'Medical license' });
    if (role === 'pharmacy') documents = await collectDocuments({ '#docDrugLicense': 'Drug license', '#docGstinProof': 'GSTIN proof' });

    const data = await api('/api/register', {
      method: 'POST',
      body: {
        role,
        name: val('#regName'), email: val('#regEmail'), phone: val('#regPhone'), password: $('#regPass').value,
        otp: val('#regOtp'),
        address: val('#regAddress'), qualification: val('#regQualification'), specialization: val('#regSpecialization'),
        fee: val('#regFee'), availability: val('#regAvailability'),
        store_name: val('#regStore'), license_no: val('#regLicense'), gstin: val('#regGstin'),
        documents,
      },
    });
    setSession(data);
    toast(data.user.status === 'pending' ? 'Registered! Awaiting admin approval.' : 'Account created!');
  } catch (e) { toast(e.message, true); }
}

function setSession(data) {
  token = data.token;
  user = data.user;
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
  closeModal();
  activeTab = null;
  render();
}

async function logout() {
  try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
  token = null; user = null; cart = [];
  localStorage.clear();
  render();
}

function goHome() { activeTab = null; render(); }

// ---------- landing ----------
async function renderLanding(search = '') {
  const [meds, docs] = await Promise.all([
    api('/api/medicines?search=' + encodeURIComponent(search)),
    api('/api/doctors?search=' + encodeURIComponent(search)),
  ]);
  app.innerHTML = `
    <div class="hero">
      <h1>Medicines & doctors, one platform</h1>
      <p>Order medicines from verified pharmacies, consult trusted doctors online, and manage your health records — all in one place.</p>
      <div class="quick-links">
        <button class="btn" onclick="requireLogin('Book Appointment')">📅 Book Appointment</button>
        <button class="btn ghost" onclick="requireLogin('Order Medicine')">🛒 Order Medicine</button>
      </div>
    </div>
    <div class="search-bar">
      <input id="landingSearch" placeholder="Search medicines or doctors…" value="${esc(search)}"
        onkeydown="if(event.key==='Enter')renderLanding(this.value)" />
      <button class="btn" onclick="renderLanding($('#landingSearch').value)">Search</button>
    </div>
    <div class="container">
      <div class="section-title">Available medicines</div>
      <div class="grid">
        ${meds.map((m) => `
          <div class="card">
            <h3>${esc(m.name)}</h3>
            <div class="meta">${esc(m.category)} · ${esc(m.store_name)}</div>
            <div class="row"><span class="price">${money(m.price)}</span>
              <button class="btn small" onclick="requireLogin('order medicines')">Add to cart</button></div>
          </div>`).join('') || '<div class="empty">No medicines found</div>'}
      </div>
      <div class="section-title" style="margin-top:32px">Our doctors</div>
      <div class="grid">
        ${docs.map((d) => `
          <div class="card">
            <h3>${esc(d.name)}</h3>
            <div class="meta">${esc(d.specialization)} · ${esc(d.qualification)}</div>
            <div class="row"><span class="price">${money(d.fee)} / visit</span>
              <button class="btn small" onclick="requireLogin('book appointments')">Book</button></div>
          </div>`).join('') || '<div class="empty">No doctors found</div>'}
      </div>
    </div>`;
}

function requireLogin(action) {
  if (!user) { toast(`Please log in to ${action}`); showLogin(); }
}

// ---------- shared dashboard scaffolding ----------
const TABS = {
  patient: ['Medicines', 'Doctors', 'My Orders', 'My Appointments', 'Prescriptions'],
  doctor: ['Appointments', 'My Prescriptions', 'Earnings', 'Profile'],
  pharmacy: ['Inventory', 'Orders'],
  admin: ['Overview', 'Approvals', 'Users', 'Orders', 'Appointments'],
};

function renderDashboard() {
  const tabs = TABS[user.role];
  if (!activeTab) activeTab = tabs[0];

  if (user.status === 'pending') {
    app.innerHTML = `<div class="container">
      <div class="banner">⏳ Your ${esc(user.role)} account is <b>awaiting admin approval</b>. You'll be notified once approved.</div>
    </div>`;
    return;
  }
  if (user.status === 'rejected') {
    app.innerHTML = `<div class="container"><div class="banner">❌ Your account was rejected by the admin. Contact support.</div></div>`;
    return;
  }

  app.innerHTML = `<div class="container">
    <div class="tabs">${tabs.map((t) => `<button class="tab ${t === activeTab ? 'active' : ''}" onclick="switchTab('${t}')">${t}</button>`).join('')}</div>
    <div id="tabContent"><div class="empty">Loading…</div></div>
  </div>`;
  renderTab();
}

function switchTab(t) { activeTab = t; renderDashboard(); }

async function renderTab() {
  const el = $('#tabContent');
  try {
    const renderers = {
      'Medicines': tabMedicines, 'Doctors': tabDoctors, 'My Orders': tabOrders, 'My Appointments': tabAppointments,
      'Prescriptions': tabPrescriptions, 'Appointments': tabAppointments, 'My Prescriptions': tabPrescriptions,
      'Earnings': tabEarnings, 'Profile': tabProfile, 'Inventory': tabInventory, 'Orders': tabOrders,
      'Overview': tabOverview, 'Approvals': tabApprovals, 'Users': tabUsers,
    };
    await renderers[activeTab](el);
  } catch (e) {
    el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ---------- patient: medicines + cart ----------
async function tabMedicines(el, search = '') {
  const meds = await api('/api/medicines?search=' + encodeURIComponent(search));
  el.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:16px;max-width:480px">
      <input id="medSearch" placeholder="Search by name or category…" value="${esc(search)}"
        onkeydown="if(event.key==='Enter')tabMedicines($('#tabContent'),this.value)" />
      <button class="btn" onclick="tabMedicines($('#tabContent'),$('#medSearch').value)">Search</button>
    </div>
    <div class="grid">
      ${meds.map((m) => `
        <div class="card">
          <h3>${esc(m.name)}</h3>
          <div class="meta">${esc(m.category)} · ${esc(m.store_name)}<br>${m.stock > 0 ? m.stock + ' in stock' : '<b style="color:var(--danger)">Out of stock</b>'}</div>
          <div class="row"><span class="price">${money(m.price)}</span>
            <button class="btn small" ${m.stock < 1 ? 'disabled' : ''}
              onclick='addToCart(${JSON.stringify({ medicine_id: m.id, name: m.name, price: m.price, store_name: m.store_name })})'>Add to cart</button>
          </div>
        </div>`).join('') || '<div class="empty">No medicines found</div>'}
    </div>`;
  renderCartFab();
}

function addToCart(item) {
  const existing = cart.find((c) => c.medicine_id === item.medicine_id);
  if (existing) existing.qty += 1;
  else cart.push({ ...item, qty: 1 });
  toast(`${item.name} added to cart`);
  renderCartFab();
}

function renderCartFab() {
  document.querySelectorAll('.cart-fab').forEach((f) => f.remove());
  if (!cart.length || !user || user.role !== 'patient') return;
  const fab = document.createElement('button');
  fab.className = 'cart-fab';
  fab.textContent = `🛒 Cart (${cart.reduce((s, c) => s + c.qty, 0)}) · ${money(cart.reduce((s, c) => s + c.price * c.qty, 0))}`;
  fab.onclick = showCart;
  document.body.appendChild(fab);
}

function showCart() {
  if (!cart.length) return toast('Cart is empty');
  const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
  openModal(`
    <h2>Your cart</h2>
    <div class="sub">Ordering from ${esc(cart[0].store_name)}</div>
    ${cart.map((c, i) => `
      <div class="row">
        <span>${esc(c.name)} × ${c.qty}</span>
        <span>${money(c.price * c.qty)} <button class="btn secondary small" onclick="removeCartItem(${i})">✕</button></span>
      </div>`).join('')}
    <div class="row" style="font-weight:700;border-top:1px solid var(--border);padding-top:10px">
      <span>Total</span><span>${money(total)}</span>
    </div>
    <label>Fulfilment</label>
    <select id="orderType"><option value="delivery">Home delivery</option><option value="pickup">Store pickup</option></select>
    <label>Delivery address</label>
    <input id="orderAddress" value="${esc(user.address || '')}" placeholder="Full address" />
    <label>Attach prescription (optional, image)</label>
    <input id="orderRx" type="file" accept="image/*" />
    <div class="actions">
      <button class="btn secondary" onclick="closeModal()">Keep shopping</button>
      <button class="btn" onclick="placeOrder()">Pay ${money(total)} (demo)</button>
    </div>`);
}

function removeCartItem(i) { cart.splice(i, 1); renderCartFab(); cart.length ? showCart() : closeModal(); }

const fileToDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });

async function placeOrder() {
  try {
    const file = $('#orderRx').files[0];
    if (file && file.size > 2 * 1024 * 1024) throw new Error('Prescription image must be under 2 MB');
    const order = await api('/api/orders', {
      method: 'POST',
      body: {
        items: cart.map((c) => ({ medicine_id: c.medicine_id, qty: c.qty })),
        type: $('#orderType').value,
        address: $('#orderAddress').value.trim(),
        prescription: file ? await fileToDataUrl(file) : null,
      },
    });
    cart = [];
    closeModal();
    renderCartFab();
    toast(`Order #${order.id} placed! Payment received (demo).`);
    switchTab('My Orders');
  } catch (e) { toast(e.message, true); }
}

// ---------- patient: doctors + booking ----------
async function tabDoctors(el, search = '') {
  const docs = await api('/api/doctors?search=' + encodeURIComponent(search));
  el.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:16px;max-width:480px">
      <input id="docSearch" placeholder="Search by name or specialty…" value="${esc(search)}"
        onkeydown="if(event.key==='Enter')tabDoctors($('#tabContent'),this.value)" />
      <button class="btn" onclick="tabDoctors($('#tabContent'),$('#docSearch').value)">Search</button>
    </div>
    <div class="grid">
      ${docs.map((d) => `
        <div class="card">
          <h3>${esc(d.name)}</h3>
          <div class="meta">${esc(d.specialization)}<br>${esc(d.qualification)}</div>
          <div class="row"><span class="price">${money(d.fee)} / visit</span>
            <button class="btn small" onclick='showBooking(${JSON.stringify(d)})'>Book</button></div>
        </div>`).join('') || '<div class="empty">No doctors found</div>'}
    </div>`;
}

function showBooking(doc) {
  const slots = (doc.availability || '').split(',').map((s) => s.trim()).filter(Boolean);
  openModal(`
    <h2>Book: ${esc(doc.name)}</h2>
    <div class="sub">${esc(doc.specialization)} · ${money(doc.fee)} per consultation (chat/video)</div>
    <label>Date</label><input id="bookDate" type="date" min="${new Date().toISOString().slice(0, 10)}" />
    <label>Available slots</label>
    <div class="slot-btns">
      ${slots.map((s) => `<button class="btn secondary small slot-opt" onclick="selectSlot(this)" data-slot="${esc(s)}">${esc(s)}</button>`).join('') || '<span class="meta">No slots listed</span>'}
    </div>
    <div class="actions">
      <button class="btn secondary" onclick="closeModal()">Cancel</button>
      <button class="btn" onclick="bookAppointment(${doc.id})">Confirm booking</button>
    </div>`);
}

let selectedSlot = null;
function selectSlot(btn) {
  selectedSlot = btn.dataset.slot;
  document.querySelectorAll('.slot-opt').forEach((b) => (b.style.background = ''));
  btn.style.background = 'var(--primary-light)';
}

async function bookAppointment(doctorId) {
  try {
    const date = $('#bookDate').value;
    if (!date || !selectedSlot) throw new Error('Pick a date and a slot');
    await api('/api/appointments', { method: 'POST', body: { doctor_id: doctorId, slot: `${date} · ${selectedSlot}` } });
    closeModal();
    selectedSlot = null;
    toast('Appointment requested! The doctor will confirm.');
    switchTab('My Appointments');
  } catch (e) { toast(e.message, true); }
}

// ---------- orders table (patient / pharmacy / admin) ----------
async function tabOrders(el) {
  const orders = await api('/api/orders');
  if (!orders.length) return (el.innerHTML = '<div class="empty">No orders yet</div>');
  el.innerHTML = `<div class="table-wrap"><table>
    <tr><th>#</th><th>${user.role === 'patient' ? 'Pharmacy' : 'Patient'}</th><th>Items</th><th>Type</th><th>Total</th><th>Status</th><th>Rx</th>${user.role === 'pharmacy' ? '<th></th>' : ''}</tr>
    ${orders.map((o) => `
      <tr>
        <td>${o.id}<br><span class="meta" style="font-size:11px;color:var(--muted)">${esc(o.created_at)}</span></td>
        <td>${esc(user.role === 'patient' ? o.store_name : o.patient_name)}</td>
        <td>${o.items.map((i) => `${esc(i.name)} × ${i.qty}`).join('<br>')}</td>
        <td>${o.type}${o.type === 'delivery' && o.address ? `<br><span style="font-size:11px;color:var(--muted)">${esc(o.address)}</span>` : ''}</td>
        <td>${money(o.total)}</td>
        <td><span class="pill ${o.status}">${o.status.replace('_', ' ')}</span></td>
        <td>${o.prescription ? `<button class="btn secondary small" onclick="viewRx(${o.id})">View</button>` : '—'}</td>
        ${user.role === 'pharmacy' ? `<td>${nextOrderAction(o)}</td>` : ''}
      </tr>`).join('')}
  </table></div>`;
  el._orders = orders;
}

function nextOrderAction(o) {
  const labels = { pending: 'Start preparing', preparing: o.type === 'delivery' ? 'Mark shipped' : 'Mark ready', shipped: 'Mark delivered', ready: 'Mark picked up' };
  return labels[o.status] ? `<button class="btn small" onclick="advanceOrder(${o.id})">${labels[o.status]}</button>` : '✓';
}

async function advanceOrder(id) {
  try {
    await api(`/api/orders/${id}`, { method: 'PATCH' });
    toast('Order status updated');
    renderTab();
  } catch (e) { toast(e.message, true); }
}

function viewRx(orderId) {
  const o = $('#tabContent')._orders.find((x) => x.id === orderId);
  const content = o.prescription.startsWith('data:image')
    ? `<img class="rx-img" style="max-width:100%" src="${o.prescription}" />`
    : `<pre style="white-space:pre-wrap;font-family:inherit">${esc(o.prescription)}</pre>`;
  openModal(`<h2>Prescription — order #${orderId}</h2>${content}
    <div class="actions"><button class="btn secondary" onclick="closeModal()">Close</button></div>`);
}

// ---------- appointments table (patient / doctor / admin) ----------
async function tabAppointments(el) {
  const appts = await api('/api/appointments');
  if (!appts.length) return (el.innerHTML = '<div class="empty">No appointments yet</div>');
  el.innerHTML = `<div class="table-wrap"><table>
    <tr><th>#</th><th>${user.role === 'doctor' ? 'Patient' : 'Doctor'}</th><th>Slot</th><th>Status</th>${user.role === 'doctor' ? '<th>Actions</th>' : ''}</tr>
    ${appts.map((a) => `
      <tr>
        <td>${a.id}</td>
        <td>${esc(user.role === 'doctor' ? a.patient_name : `${a.doctor_name} (${a.specialization})`)}</td>
        <td>${esc(a.slot)}</td>
        <td><span class="pill ${a.status}">${a.status}</span></td>
        ${user.role === 'doctor' ? `<td>${doctorApptActions(a)}</td>` : ''}
      </tr>`).join('')}
  </table></div>`;
}

function doctorApptActions(a) {
  if (a.status === 'pending')
    return `<button class="btn small" onclick="setAppt(${a.id},'confirmed')">Accept</button>
      <button class="btn danger small" onclick="setAppt(${a.id},'rejected')">Reject</button>`;
  if (a.status === 'confirmed')
    return `<button class="btn small" onclick="showWriteRx(${a.id})">Write e-prescription</button>`;
  return '—';
}

async function setAppt(id, status) {
  try {
    await api(`/api/appointments/${id}`, { method: 'PATCH', body: { status } });
    toast(`Appointment ${status}`);
    renderTab();
  } catch (e) { toast(e.message, true); }
}

function showWriteRx(apptId) {
  openModal(`
    <h2>e-Prescription</h2>
    <div class="sub">Completing this consultation uploads the prescription to the patient.</div>
    <label>Prescription</label>
    <textarea id="rxContent" rows="6" placeholder="Rx&#10;1. Paracetamol 500mg — 1 tab twice daily × 5 days&#10;2. ..."></textarea>
    <div class="actions">
      <button class="btn secondary" onclick="closeModal()">Cancel</button>
      <button class="btn" onclick="submitRx(${apptId})">Upload prescription</button>
    </div>`);
}

async function submitRx(apptId) {
  try {
    await api('/api/prescriptions', { method: 'POST', body: { appointment_id: apptId, content: $('#rxContent').value } });
    closeModal();
    toast('e-Prescription uploaded, consultation completed');
    renderTab();
  } catch (e) { toast(e.message, true); }
}

// ---------- prescriptions ----------
async function tabPrescriptions(el) {
  const rxs = await api('/api/prescriptions');
  const uploadUi = user.role === 'patient'
    ? `<div style="display:flex;gap:8px;margin-bottom:16px;align-items:center;max-width:480px">
        <input id="rxUpload" type="file" accept="image/*" />
        <button class="btn" onclick="uploadRx()">Upload prescription</button>
      </div>` : '';
  el.innerHTML = uploadUi + (rxs.length
    ? `<div class="grid">${rxs.map((r) => `
        <div class="card">
          <h3>${r.kind === 'eprescription' ? '🩺 e-Prescription' : '📄 Uploaded'}</h3>
          <div class="meta">${r.doctor_name ? 'By ' + esc(r.doctor_name) + ' · ' : ''}${user.role === 'doctor' ? 'For ' + esc(r.patient_name) + ' · ' : ''}${esc(r.created_at)}</div>
          ${r.content.startsWith('data:image')
            ? `<img class="rx-img" src="${r.content}" />`
            : `<pre style="white-space:pre-wrap;font-family:inherit;font-size:13px">${esc(r.content)}</pre>`}
        </div>`).join('')}</div>`
    : '<div class="empty">No prescriptions yet</div>');
}

async function uploadRx() {
  try {
    const file = $('#rxUpload').files[0];
    if (!file) throw new Error('Choose an image first');
    if (file.size > 2 * 1024 * 1024) throw new Error('Image must be under 2 MB');
    await api('/api/prescriptions/upload', { method: 'POST', body: { content: await fileToDataUrl(file) } });
    toast('Prescription uploaded');
    renderTab();
  } catch (e) { toast(e.message, true); }
}

// ---------- doctor: earnings + profile ----------
async function tabEarnings(el) {
  const e = await api('/api/earnings');
  el.innerHTML = `<div class="stats">
    <div class="stat"><div class="num">${e.consultations}</div><div class="label">Completed consultations</div></div>
    <div class="stat"><div class="num">${money(e.total)}</div><div class="label">Total earnings</div></div>
    <div class="stat"><div class="num">${money(user.fee || 0)}</div><div class="label">Fee per consultation</div></div>
  </div>`;
}

async function tabProfile(el) {
  el.innerHTML = `<div class="card" style="max-width:480px">
    <h3>Profile & availability</h3>
    <label>Consultation fee (₹)</label><input id="profFee" type="number" value="${user.fee || ''}" />
    <label>Availability slots (comma separated)</label><input id="profAvail" value="${esc(user.availability || '')}" />
    <label>Specialization</label><input id="profSpec" value="${esc(user.specialization || '')}" />
    <div class="actions"><button class="btn" onclick="saveProfile()">Save</button></div>
  </div>`;
}

async function saveProfile() {
  try {
    user = await api('/api/me', {
      method: 'PATCH',
      body: { fee: Number($('#profFee').value) || null, availability: $('#profAvail').value, specialization: $('#profSpec').value },
    });
    localStorage.setItem('user', JSON.stringify(user));
    toast('Profile updated');
  } catch (e) { toast(e.message, true); }
}

// ---------- pharmacy: inventory ----------
async function tabInventory(el) {
  const meds = await api('/api/my-medicines');
  el.innerHTML = `
    <div style="margin-bottom:14px"><button class="btn" onclick="showMedForm()">＋ Add medicine</button></div>
    ${meds.length ? `<div class="table-wrap"><table>
      <tr><th>Name</th><th>Category</th><th>Price</th><th>Stock</th><th></th></tr>
      ${meds.map((m) => `
        <tr>
          <td>${esc(m.name)}</td><td>${esc(m.category)}</td><td>${money(m.price)}</td>
          <td>${m.stock < 10 ? `<b style="color:var(--danger)">${m.stock} ⚠️</b>` : m.stock}</td>
          <td>
            <button class="btn secondary small" onclick='showMedForm(${JSON.stringify(m)})'>Edit</button>
            <button class="btn danger small" onclick="deleteMed(${m.id})">Delete</button>
          </td>
        </tr>`).join('')}
    </table></div>` : '<div class="empty">No medicines added yet</div>'}`;
}

function showMedForm(m) {
  openModal(`
    <h2>${m ? 'Edit' : 'Add'} medicine</h2>
    <label>Name</label><input id="medName" value="${esc(m?.name || '')}" />
    <label>Category</label><input id="medCategory" value="${esc(m?.category || '')}" placeholder="Pain Relief" />
    <label>Price (₹)</label><input id="medPrice" type="number" step="0.01" value="${m?.price ?? ''}" />
    <label>Stock</label><input id="medStock" type="number" value="${m?.stock ?? ''}" />
    <div class="actions">
      <button class="btn secondary" onclick="closeModal()">Cancel</button>
      <button class="btn" onclick="saveMed(${m ? m.id : 'null'})">Save</button>
    </div>`);
}

async function saveMed(id) {
  try {
    const body = { name: $('#medName').value.trim(), category: $('#medCategory').value.trim(), price: $('#medPrice').value, stock: $('#medStock').value };
    await api(id ? `/api/medicines/${id}` : '/api/medicines', { method: id ? 'PATCH' : 'POST', body });
    closeModal();
    toast('Saved');
    renderTab();
  } catch (e) { toast(e.message, true); }
}

async function deleteMed(id) {
  if (!confirm('Delete this medicine?')) return;
  await api(`/api/medicines/${id}`, { method: 'DELETE' });
  toast('Deleted');
  renderTab();
}

// ---------- admin ----------
async function tabOverview(el) {
  const s = await api('/api/admin/stats');
  el.innerHTML = `<div class="stats">
    <div class="stat"><div class="num">${s.patients}</div><div class="label">Patients</div></div>
    <div class="stat"><div class="num">${s.doctors}</div><div class="label">Approved doctors</div></div>
    <div class="stat"><div class="num">${s.pharmacies}</div><div class="label">Approved pharmacies</div></div>
    <div class="stat"><div class="num">${s.pending_approvals}</div><div class="label">Pending approvals</div></div>
    <div class="stat"><div class="num">${s.orders}</div><div class="label">Orders</div></div>
    <div class="stat"><div class="num">${money(s.revenue)}</div><div class="label">Order revenue</div></div>
    <div class="stat"><div class="num">${s.appointments}</div><div class="label">Appointments</div></div>
  </div>
  ${s.pending_approvals ? `<div class="banner">⚠️ ${s.pending_approvals} registration(s) awaiting your approval — see the <b>Approvals</b> tab.</div>` : ''}`;
}

async function tabApprovals(el) {
  const users = await api('/api/admin/users?status=pending');
  if (!users.length) return (el.innerHTML = '<div class="empty">No pending approvals 🎉</div>');
  el.innerHTML = `<div class="table-wrap"><table>
    <tr><th>Role</th><th>Name</th><th>Details</th><th>Actions</th></tr>
    ${users.map((u) => `
      <tr>
        <td><span class="badge-role">${u.role}</span></td>
        <td>${esc(u.name)}<br><span style="font-size:12px;color:var(--muted)">${esc(u.email)}</span></td>
        <td style="font-size:13px">${u.role === 'doctor'
          ? `${esc(u.qualification)} · ${esc(u.specialization)} · fee ${money(u.fee || 0)}`
          : `${esc(u.store_name)} · License ${esc(u.license_no)} · GSTIN ${esc(u.gstin)}`}</td>
        <td>
          ${u.documents ? `<button class="btn secondary small" onclick="viewDocs(${u.id})">View documents</button><br>` : '<span class="meta" style="font-size:11px;color:var(--warn)">No documents</span><br>'}
          <button class="btn small" onclick="approveUser(${u.id},'approved')">Approve</button>
          <button class="btn danger small" onclick="approveUser(${u.id},'rejected')">Reject</button>
        </td>
      </tr>`).join('')}
  </table></div>`;
  el._users = users;
}

function viewDocs(userId) {
  const u = $('#tabContent')._users.find((x) => x.id === userId);
  let docs = {};
  try { docs = JSON.parse(u.documents || '{}'); } catch (e) {}
  const body = Object.entries(docs).map(([label, src]) =>
    `<label>${esc(label)}</label>${String(src).startsWith('data:image')
      ? `<img class="rx-img" style="max-width:100%" src="${src}" />`
      : `<div class="meta">${esc(String(src))}</div>`}`).join('') || '<div class="empty">No documents uploaded</div>';
  openModal(`<h2>Verification documents</h2><div class="sub">${esc(u.name)} · ${esc(u.role)}</div>${body}
    <div class="actions"><button class="btn secondary" onclick="closeModal()">Close</button></div>`);
}

async function approveUser(id, status) {
  try {
    await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { status } });
    toast(`User ${status}`);
    renderTab();
  } catch (e) { toast(e.message, true); }
}

async function tabUsers(el) {
  const users = await api('/api/admin/users');
  el.innerHTML = `<div class="table-wrap"><table>
    <tr><th>ID</th><th>Role</th><th>Name</th><th>Email</th><th>Phone</th><th>Status</th></tr>
    ${users.map((u) => `
      <tr><td>${u.id}</td><td>${u.role}</td><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
      <td>${esc(u.phone || '—')}</td><td><span class="pill ${u.status}">${u.status}</span></td></tr>`).join('')}
  </table></div>`;
}

// ---------- boot ----------
function render() {
  renderNav();
  renderCartFab();
  document.querySelectorAll('.notif-panel').forEach((p) => p.remove());
  if (user) renderDashboard();
  else renderLanding();
}

render();
