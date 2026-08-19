/* Patient-facing tabs: medicine catalog with cart + checkout, doctor search + booking, refills. */
import { useEffect, useState } from 'react';
import { api, money, fileToDataUrl } from '../api';
import { Empty, ModalActions, useUI } from '../ui';

/* ---------- Medicines: search, add to cart ---------- */
export function MedicinesTab({ cart, setCart }) {
  const { toast } = useUI();
  const [meds, setMeds] = useState(null);
  const [search, setSearch] = useState('');

  const load = (q = '') => api('/api/medicines?search=' + encodeURIComponent(q)).then(setMeds);
  useEffect(() => { load(); }, []);

  const addToCart = (m) => {
    const existing = cart.find((c) => c.medicine_id === m.id);
    setCart(existing
      ? cart.map((c) => (c.medicine_id === m.id ? { ...c, qty: c.qty + 1 } : c))
      : [...cart, { medicine_id: m.id, name: m.name, price: m.price, store_name: m.store_name, qty: 1 }]);
    toast(`${m.name} added to cart`);
  };

  if (!meds) return <Empty>Loading…</Empty>;
  return (
    <>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, maxWidth: 480 }}>
        <input aria-label="Search medicines" placeholder="Search by name or category…" value={search}
               onChange={(e) => setSearch(e.target.value)}
               onKeyDown={(e) => e.key === 'Enter' && load(search)} />
        <button className="btn" onClick={() => load(search)}>Search</button>
      </div>
      <div className="grid">
        {meds.length === 0 && <Empty>No medicines found</Empty>}
        {meds.map((m) => (
          <div className="card" key={m.id}>
            <h3>{m.name}</h3>
            <div className="meta">{m.category} · {m.store_name}<br />
              {m.stock > 0 ? `${m.stock} in stock` : <b style={{ color: 'var(--danger)' }}>Out of stock</b>}</div>
            <div className="row">
              <span className="price">{money(m.price)}</span>
              <button className="btn small" disabled={m.stock < 1} onClick={() => addToCart(m)}>Add to cart</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ---------- Cart + checkout (payment intent -> verified order) ---------- */
export function CartModal({ cart, setCart, user, onOrdered, config }) {
  const { closeModal, toast } = useUI();
  const [type, setType] = useState('delivery');
  const [address, setAddress] = useState(user.address || '');
  const [rxFile, setRxFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const total = cart.reduce((s, c) => s + c.price * c.qty, 0);

  const remove = (i) => {
    const next = cart.filter((_, idx) => idx !== i);
    setCart(next);
    if (!next.length) closeModal();
  };

  const placeOrder = async () => {
    setBusy(true);
    try {
      if (rxFile && rxFile.size > 2 * 1024 * 1024) throw new Error('Prescription image must be under 2 MB');
      const items = cart.map((c) => ({ medicine_id: c.medicine_id, qty: c.qty }));
      // Two-step checkout: create a payment intent, then place the paid order. The sandbox gateway
      // returns `demoCheckout` — the signed fields a real Stripe/Razorpay widget would hand back.
      const intent = await api('/api/payments/create', { method: 'POST', body: { items } });
      if (!intent.demoCheckout) throw new Error('Live payment keys configured but the checkout widget is not loaded in this build');
      toast('Payment successful ✓');
      const order = await api('/api/orders', {
        method: 'POST',
        body: {
          items, type, address: address.trim(),
          prescription: rxFile ? await fileToDataUrl(rxFile) : null,
          payment: intent.demoCheckout,
        },
      });
      setCart([]);
      closeModal();
      toast(`Order #${order.id} placed & paid ✓`);
      onOrdered();
    } catch (err) {
      toast(err.message, true);
    } finally {
      setBusy(false);
    }
  };

  const provider = (config.paymentProvider || 'stripe');
  return (
    <div>
      <h2>Your cart</h2>
      <div className="sub">Ordering from {cart[0]?.store_name}</div>
      {cart.map((c, i) => (
        <div className="row" key={c.medicine_id}>
          <span>{c.name} × {c.qty}</span>
          <span>{money(c.price * c.qty)}{' '}
            <button className="btn secondary small" aria-label={`Remove ${c.name}`} onClick={() => remove(i)}>✕</button>
          </span>
        </div>
      ))}
      <div className="row" style={{ fontWeight: 700, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        <span>Total</span><span>{money(total)}</span>
      </div>
      <label htmlFor="orderType">Fulfilment</label>
      <select id="orderType" value={type} onChange={(e) => setType(e.target.value)}>
        <option value="delivery">Home delivery</option>
        <option value="pickup">Store pickup</option>
      </select>
      <label htmlFor="orderAddress">Delivery address</label>
      <input id="orderAddress" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Full address" />
      <label htmlFor="orderRx">Attach prescription (optional, image)</label>
      <input id="orderRx" type="file" accept="image/*" onChange={(e) => setRxFile(e.target.files[0])} />
      <div className="meta" style={{ marginTop: 10 }}>
        🔒 Payments via {provider[0].toUpperCase() + provider.slice(1)}{config.mock ? ' (sandbox)' : ''}
      </div>
      <ModalActions>
        <button className="btn secondary" onClick={closeModal}>Keep shopping</button>
        <button className="btn" onClick={placeOrder} disabled={busy}>{busy ? 'Processing…' : `Pay ${money(total)}`}</button>
      </ModalActions>
    </div>
  );
}

/* ---------- Doctors: search + book a slot ---------- */
export function DoctorsTab({ onBooked }) {
  const { openModal } = useUI();
  const [docs, setDocs] = useState(null);
  const [search, setSearch] = useState('');

  const load = (q = '') => api('/api/doctors?search=' + encodeURIComponent(q)).then(setDocs);
  useEffect(() => { load(); }, []);

  if (!docs) return <Empty>Loading…</Empty>;
  return (
    <>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, maxWidth: 480 }}>
        <input aria-label="Search doctors" placeholder="Search by name or specialty…" value={search}
               onChange={(e) => setSearch(e.target.value)}
               onKeyDown={(e) => e.key === 'Enter' && load(search)} />
        <button className="btn" onClick={() => load(search)}>Search</button>
      </div>
      <div className="grid">
        {docs.length === 0 && <Empty>No doctors found</Empty>}
        {docs.map((d) => (
          <div className="card" key={d.id}>
            <h3>{d.name}</h3>
            <div className="meta">{d.specialization}<br />{d.qualification}</div>
            <div className="row">
              <span className="price">{money(d.fee)} / visit</span>
              <button className="btn small" onClick={() => openModal(<BookingForm doctor={d} onBooked={onBooked} />)}>Book</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function BookingForm({ doctor, onBooked }) {
  const { closeModal, toast } = useUI();
  const [date, setDate] = useState('');
  const [slot, setSlot] = useState(null);
  const slots = (doctor.availability || '').split(',').map((s) => s.trim()).filter(Boolean);

  const confirm = async () => {
    try {
      if (!date || !slot) throw new Error('Pick a date and a slot');
      await api('/api/appointments', { method: 'POST', body: { doctor_id: doctor.id, slot: `${date} · ${slot}` } });
      closeModal();
      toast('Appointment requested! The doctor will confirm.');
      onBooked();
    } catch (err) {
      toast(err.message, true);
    }
  };

  return (
    <div>
      <h2>Book: {doctor.name}</h2>
      <div className="sub">{doctor.specialization} · {money(doctor.fee)} per consultation (chat/video)</div>
      <label htmlFor="bookDate">Date</label>
      <input id="bookDate" type="date" min={new Date().toISOString().slice(0, 10)}
             value={date} onChange={(e) => setDate(e.target.value)} />
      <label>Available slots</label>
      <div className="slot-btns">
        {slots.length === 0 && <span className="meta">No slots listed</span>}
        {slots.map((s) => (
          <button key={s} className="btn secondary small" aria-pressed={slot === s}
                  style={slot === s ? { background: 'var(--primary-light)' } : undefined}
                  onClick={() => setSlot(s)}>{s}</button>
        ))}
      </div>
      <ModalActions>
        <button className="btn secondary" onClick={closeModal}>Cancel</button>
        <button className="btn" onClick={confirm}>Confirm booking</button>
      </ModalActions>
    </div>
  );
}

/* ---------- Refill reminders ---------- */
export function RefillsTab() {
  const [refills, setRefills] = useState(null);
  useEffect(() => { api('/api/refills').then(setRefills); }, []);

  if (!refills) return <Empty>Loading…</Empty>;
  if (!refills.length) return <Empty>No refill reminders yet — they are scheduled automatically after you order medicines.</Empty>;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Medicine</th><th>Next refill due</th><th>Status</th></tr></thead>
        <tbody>
          {refills.map((r) => {
            const due = String(r.due_date).slice(0, 10);
            const isDue = due <= today;
            return (
              <tr key={r.id}>
                <td>{r.medicine_name}</td>
                <td>{due}</td>
                <td><span className={`pill ${isDue ? 'pending' : 'confirmed'}`}>{isDue ? 'Due now' : 'Upcoming'}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
