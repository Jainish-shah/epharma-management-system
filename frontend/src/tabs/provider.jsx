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
            <thead><tr><th>Name</th><th>Category</th><th>Price</th><th>Stock</th><th>Actions</th></tr></thead>
            <tbody>
              {meds.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>{m.category}</td>
                  <td>{money(m.price)}</td>
                  {/* low stock is called out so the pharmacy can reorder */}
                  <td>{m.stock < 10 ? <b style={{ color: 'var(--danger)' }}>{m.stock} ⚠️</b> : m.stock}</td>
                  <td>
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
    price: med?.price ?? '', stock: med?.stock ?? '',
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
      <label htmlFor="medPrice">Price (₹)</label>
      <input id="medPrice" type="number" step="0.01" value={f.price} onChange={set('price')} />
      <label htmlFor="medStock">Stock</label>
      <input id="medStock" type="number" value={f.stock} onChange={set('stock')} />
      <ModalActions>
        <button className="btn secondary" onClick={closeModal}>Cancel</button>
        <button className="btn" onClick={save}>Save</button>
      </ModalActions>
    </div>
  );
}
