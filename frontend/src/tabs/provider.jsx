/* Provider tabs: doctor earnings & profile, pharmacy inventory. */
import { useEffect, useState } from 'react';
import { api, money } from '../api';
import { Empty, ModalActions, useUI } from '../ui';

/* ---------- Doctor: earnings ---------- */
export function EarningsTab({ user }) {
  const [e, setE] = useState(null);
  useEffect(() => { api('/api/earnings').then(setE); }, []);
  if (!e) return <Empty>Loading…</Empty>;
  return (
    <div className="stats">
      <div className="stat"><div className="num">{e.consultations}</div><div className="label">Completed consultations</div></div>
      <div className="stat"><div className="num">{money(e.total)}</div><div className="label">Total earnings</div></div>
      <div className="stat"><div className="num">{money(user.fee || 0)}</div><div className="label">Fee per consultation</div></div>
    </div>
  );
}

/* ---------- Doctor: profile & availability ---------- */
export function ProfileTab({ user, onUpdated }) {
  const { toast } = useUI();
  const [fee, setFee] = useState(user.fee || '');
  const [availability, setAvailability] = useState(user.availability || '');
  const [specialization, setSpecialization] = useState(user.specialization || '');

  const save = async () => {
    try {
      const updated = await api('/api/me', {
        method: 'PATCH',
        body: { fee: Number(fee) || null, availability, specialization },
      });
      onUpdated(updated);
      toast('Profile updated');
    } catch (err) { toast(err.message, true); }
  };

  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <h3>Profile &amp; availability</h3>
      <label htmlFor="profFee">Consultation fee (₹)</label>
      <input id="profFee" type="number" value={fee} onChange={(e) => setFee(e.target.value)} />
      <label htmlFor="profAvail">Availability slots (comma separated)</label>
      <input id="profAvail" value={availability} onChange={(e) => setAvailability(e.target.value)} />
      <label htmlFor="profSpec">Specialization</label>
      <input id="profSpec" value={specialization} onChange={(e) => setSpecialization(e.target.value)} />
      <ModalActions><button className="btn" onClick={save}>Save</button></ModalActions>
    </div>
  );
}

/* ---------- Pharmacy: inventory CRUD ---------- */
export function InventoryTab() {
  const { openModal, toast } = useUI();
  const [meds, setMeds] = useState(null);
  const load = () => api('/api/my-medicines').then(setMeds);
  useEffect(() => { load(); }, []);

  const remove = async (id) => {
    if (!confirm('Delete this medicine?')) return;
    await api(`/api/medicines/${id}`, { method: 'DELETE' });
    toast('Deleted');
    load();
  };

  if (!meds) return <Empty>Loading…</Empty>;
  return (
    <>
      <div style={{ marginBottom: 14 }}>
        <button className="btn" onClick={() => openModal(<MedicineForm onSaved={load} />)}>＋ Add medicine</button>
      </div>
      {meds.length === 0 ? <Empty>No medicines added yet</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Category</th><th>Price</th><th>GST</th><th>Stock</th><th>Actions</th></tr></thead>
            <tbody>
              {meds.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>{m.category}</td>
                  <td>{money(m.price)}</td>
                  <td>{m.gst_rate ?? 5}%</td>
                  {/* low stock is called out so the pharmacy can reorder */}
                  <td>{m.stock < 10 ? <b style={{ color: 'var(--danger)' }}>{m.stock} ⚠️</b> : m.stock}</td>
                  <td>
                    <button className="btn small" onClick={() => openModal(<StockLedger med={m} onSaved={load} />)}>Stock</button>{' '}
                    <button className="btn secondary small" onClick={() => openModal(<MedicineForm med={m} onSaved={load} />)}>Edit</button>{' '}
                    <button className="btn danger small" onClick={() => remove(m.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function MedicineForm({ med, onSaved }) {
  const { closeModal, toast } = useUI();
  const [f, setF] = useState({
    name: med?.name || '', category: med?.category || '',
    price: med?.price ?? '', stock: med?.stock ?? '', gst_rate: med?.gst_rate ?? 5,
  });
  const [categories, setCategories] = useState([]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  // Admin-managed category suggestions (advisory — free text is still accepted).
  useEffect(() => { api('/api/taxonomy?type=category').then(setCategories).catch(() => {}); }, []);

  const save = async () => {
    try {
      await api(med ? `/api/medicines/${med.id}` : '/api/medicines', { method: med ? 'PATCH' : 'POST', body: f });
      closeModal();
      toast('Saved');
      onSaved();
    } catch (err) { toast(err.message, true); }
  };

  return (
    <div>
      <h2>{med ? 'Edit' : 'Add'} medicine</h2>
      <label htmlFor="medName">Name</label>
      <input id="medName" value={f.name} onChange={set('name')} />
      <label htmlFor="medCategory">Category</label>
      <input id="medCategory" list="catList" value={f.category} onChange={set('category')} placeholder="Pain Relief" />
      <datalist id="catList">{categories.map((c) => <option key={c.id} value={c.name} />)}</datalist>
      <label htmlFor="medPrice">MRP (₹, inclusive of GST)</label>
      <input id="medPrice" type="number" step="0.01" value={f.price} onChange={set('price')} />
      <label htmlFor="medGst">GST slab</label>
      <select id="medGst" value={f.gst_rate} onChange={set('gst_rate')}>
        <option value="5">5% — most medicines</option>
        <option value="12">12% — supplements, nutraceuticals</option>
        <option value="18">18% — other goods</option>
      </select>
      <label htmlFor="medStock">Stock{med && ' (use Stock ▸ to book movements)'}</label>
      <input id="medStock" type="number" value={f.stock} onChange={set('stock')} />
      <ModalActions>
        <button className="btn secondary" onClick={closeModal}>Cancel</button>
        <button className="btn" onClick={save}>Save</button>
      </ModalActions>
    </div>
  );
}

/* ---------- Pharmacy: stock in/out ledger ----------
 * Restocking through this dialog records how many units moved and why. The edit form can still
 * overwrite the level directly, but that is logged as an 'adjustment' so no change goes unexplained. */
function StockLedger({ med, onSaved }) {
  const { closeModal, toast } = useUI();
  const [moves, setMoves] = useState(null);
  const [stock, setStock] = useState(med.stock);
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('restock');
  const load = () => api(`/api/medicines/${med.id}/stock`).then(setMoves);
  useEffect(() => { load(); }, []);

  // Restocks and returns add units; write-offs remove them. The sign is implied by the reason,
  // so the pharmacist types a plain quantity rather than remembering to type a minus.
  const incoming = ['restock', 'return'].includes(reason);

  const book = async () => {
    try {
      const n = Math.abs(Number(qty));
      if (!n) throw new Error('Enter a quantity');
      const updated = await api(`/api/medicines/${med.id}/stock`, {
        method: 'POST', body: { delta: incoming ? n : -n, reason },
      });
      setStock(updated.stock);
      setQty('');
      toast(`Stock ${incoming ? 'in' : 'out'}: ${n} unit(s)`);
      load();
      onSaved();
    } catch (err) { toast(err.message, true); }
  };

  return (
    <div className="stock-dialog">
      <h2>Stock — {med.name}</h2>
      <div className="sub">On hand: <b>{stock}</b></div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '0 0 110px' }}>
          <label htmlFor="stkQty">Quantity</label>
          <input id="stkQty" type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label htmlFor="stkReason">Reason</label>
          <select id="stkReason" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="restock">Stock in — purchase</option>
            <option value="return">Stock in — customer return</option>
            <option value="damage">Stock out — damaged</option>
            <option value="expiry">Stock out — expired</option>
            <option value="adjustment">Stock out — correction</option>
          </select>
        </div>
        <button className="btn" onClick={book}>{incoming ? 'Add' : 'Remove'}</button>
      </div>

      <div className="section-title" style={{ marginTop: 18 }}>Movement history</div>
      {!moves ? <Empty>Loading…</Empty> : moves.length === 0 ? <Empty>No movements yet</Empty> : (
        <div className="table-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
          <table>
            <thead><tr><th>When</th><th>Change</th><th>Balance</th><th>Reason</th><th>By</th></tr></thead>
            <tbody>
              {moves.map((m) => (
                <tr key={m.id}>
                  <td className="meta" style={{ fontSize: 11 }}>{m.created_at}</td>
                  <td style={{ color: m.delta < 0 ? 'var(--danger)' : 'var(--primary-dark)', fontWeight: 700 }}>
                    {m.delta > 0 ? `+${m.delta}` : m.delta}
                  </td>
                  <td>{m.balance}</td>
                  <td>{m.reason}</td>
                  <td>{m.actor_name || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ModalActions><button className="btn secondary" onClick={closeModal}>Close</button></ModalActions>
    </div>
  );
}
