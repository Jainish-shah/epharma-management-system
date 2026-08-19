/* Admin tabs: KPI overview, reports, approval queue, user registry, catalog and CMS management. */
import { useEffect, useState } from 'react';
import { api, money } from '../api';
import { Empty, ModalActions, Pill, useUI } from '../ui';

/* ---------- Overview: headline KPIs ---------- */
export function OverviewTab() {
  const [s, setS] = useState(null);
  useEffect(() => { api('/api/admin/stats').then(setS); }, []);
  if (!s) return <Empty>Loading…</Empty>;
  const cards = [
    [s.patients, 'Patients'], [s.doctors, 'Approved doctors'], [s.pharmacies, 'Approved pharmacies'],
    [s.pending_approvals, 'Pending approvals'], [s.orders, 'Orders'],
    [money(s.revenue), 'Order revenue'], [s.appointments, 'Appointments'],
  ];
  return (
    <>
      <div className="stats">
        {cards.map(([num, label]) => (
          <div className="stat" key={label}><div className="num">{num}</div><div className="label">{label}</div></div>
        ))}
      </div>
      {s.pending_approvals > 0 && (
        <div className="banner">⚠️ {s.pending_approvals} registration(s) awaiting your approval — see the <b>Approvals</b> tab.</div>
      )}
    </>
  );
}

/* ---------- Reports: CSS bar charts, no charting library ---------- */
function BarRow({ label, value, max, suffix = '' }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0', fontSize: 13 }}>
      <div style={{ width: 150, flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, background: 'var(--bg)', borderRadius: 6, overflow: 'hidden' }}>
        <div style={{
          width: `${pct}%`, minWidth: 2, background: 'var(--primary)', color: '#fff',
          padding: '3px 8px', borderRadius: 6, whiteSpace: 'nowrap',
        }}>{value}{suffix}</div>
      </div>
    </div>
  );
}

const Section = ({ title, children, empty }) => (
  <div className="card" style={{ marginBottom: 16 }}>
    <h3>{title}</h3>
    {empty ? <Empty>No data yet</Empty> : children}
  </div>
);

export function ReportsTab() {
  const [r, setR] = useState(null);
  useEffect(() => { api('/api/admin/reports').then(setR); }, []);
  if (!r) return <Empty>Loading…</Empty>;

  const maxRev = Math.max(1, ...r.revenue_by_day.map((d) => d.revenue));
  const maxMed = Math.max(1, ...r.top_medicines.map((m) => m.units));
  const maxPh = Math.max(1, ...r.revenue_by_pharmacy.map((p) => p.revenue));

  return (
    <>
      <Section title="Revenue by day" empty={!r.revenue_by_day.length}>
        {r.revenue_by_day.map((d) => <BarRow key={d.day} label={d.day} value={d.revenue} max={maxRev} suffix={` (${d.orders} orders)`} />)}
      </Section>
      <Section title="Top medicines (units sold)" empty={!r.top_medicines.length}>
        {r.top_medicines.map((m) => <BarRow key={m.name} label={m.name} value={m.units} max={maxMed} suffix={` · ${money(m.revenue)}`} />)}
      </Section>
      <Section title="Revenue by pharmacy" empty={!r.revenue_by_pharmacy.length}>
        {r.revenue_by_pharmacy.map((p) => <BarRow key={p.pharmacy} label={p.pharmacy} value={p.revenue} max={maxPh} suffix={` (${p.orders})`} />)}
      </Section>
      <div className="stats">
        <div className="stat"><div className="num">{r.consultations.total}</div><div className="label">Completed consultations</div></div>
        <div className="stat"><div className="num">{money(r.consultations.revenue)}</div><div className="label">Consultation revenue</div></div>
        {r.orders_by_status.map((s) => (
          <div className="stat" key={s.status}><div className="num">{s.count}</div><div className="label">Orders: {s.status}</div></div>
        ))}
      </div>
    </>
  );
}

/* ---------- Approvals: verify documents, approve or reject ---------- */
export function ApprovalsTab() {
  const { openModal, toast } = useUI();
  const [users, setUsers] = useState(null);
  const load = () => api('/api/admin/users?status=pending').then(setUsers);
  useEffect(() => { load(); }, []);

  const decide = async (id, status) => {
    try {
      await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { status } });
      toast(`User ${status}`);
      load();
    } catch (err) { toast(err.message, true); }
  };

  if (!users) return <Empty>Loading…</Empty>;
  if (!users.length) return <Empty>No pending approvals 🎉</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Role</th><th>Name</th><th>Details</th><th>Actions</th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td><span className="badge-role">{u.role}</span></td>
              <td>{u.name}<br /><span style={{ fontSize: 12, color: 'var(--muted)' }}>{u.email}</span></td>
              <td style={{ fontSize: 13 }}>
                {u.role === 'doctor'
                  ? `${u.qualification} · ${u.specialization} · fee ${money(u.fee || 0)}`
                  : `${u.store_name} · License ${u.license_no} · GSTIN ${u.gstin}`}
              </td>
              <td>
                {u.documents
                  ? <button className="btn secondary small" onClick={() => openModal(<DocViewer user={u} />)}>View documents</button>
                  : <span className="meta" style={{ fontSize: 11, color: 'var(--warn)' }}>No documents</span>}
                <br />
                <button className="btn small" onClick={() => decide(u.id, 'approved')}>Approve</button>{' '}
                <button className="btn danger small" onClick={() => decide(u.id, 'rejected')}>Reject</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DocViewer({ user }) {
  const { closeModal } = useUI();
  let docs = {};
  try { docs = JSON.parse(user.documents || '{}'); } catch { /* not JSON */ }
  const entries = Object.entries(docs);
  return (
    <div>
      <h2>Verification documents</h2>
      <div className="sub">{user.name} · {user.role}</div>
      {entries.length === 0 && <Empty>No documents uploaded</Empty>}
      {entries.map(([label, src]) => (
        <div key={label}>
          <label>{label}</label>
          {String(src).startsWith('data:image')
            ? <img className="rx-img" style={{ maxWidth: '100%' }} src={src} alt={label} />
            : <div className="meta">{String(src)}</div>}
        </div>
      ))}
      <ModalActions><button className="btn secondary" onClick={closeModal}>Close</button></ModalActions>
    </div>
  );
}

/* ---------- Users registry ---------- */
export function UsersTab() {
  const [users, setUsers] = useState(null);
  useEffect(() => { api('/api/admin/users').then(setUsers); }, []);
  if (!users) return <Empty>Loading…</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>ID</th><th>Role</th><th>Name</th><th>Email</th><th>Phone</th><th>Status</th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.id}</td><td>{u.role}</td><td>{u.name}</td><td>{u.email}</td>
              <td>{u.phone || '—'}</td><td><Pill status={u.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- Catalog: manage categories & specialties ---------- */
export function CatalogTab() {
  const { toast } = useUI();
  const [tax, setTax] = useState(null);
  const [drafts, setDrafts] = useState({ category: '', specialty: '' });
  const load = () => api('/api/taxonomy').then(setTax);
  useEffect(() => { load(); }, []);

  const add = async (type) => {
    const name = drafts[type].trim();
    if (!name) return;
    try {
      await api('/api/admin/taxonomy', { method: 'POST', body: { type, name } });
      setDrafts({ ...drafts, [type]: '' });
      load();
    } catch (err) { toast(err.message, true); }
  };

  const remove = async (id) => { await api(`/api/admin/taxonomy/${id}`, { method: 'DELETE' }); load(); };

  if (!tax) return <Empty>Loading…</Empty>;
  const group = (type, title) => {
    const items = tax.filter((t) => t.type === type);
    return (
      <div className="card" style={{ marginBottom: 16 }} key={type}>
        <h3>{title}</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '10px 0' }}>
          {items.length === 0 && <span className="meta">None yet</span>}
          {items.map((t) => (
            <span className="badge-role" key={t.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {t.name}
              <button onClick={() => remove(t.id)} aria-label={`Remove ${t.name}`}
                      style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--danger)', fontWeight: 700 }}>✕</button>
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, maxWidth: 360 }}>
          <input aria-label={`Add ${type}`} placeholder={`Add ${type}…`} value={drafts[type]}
                 onChange={(e) => setDrafts({ ...drafts, [type]: e.target.value })}
                 onKeyDown={(e) => e.key === 'Enter' && add(type)} />
          <button className="btn small" onClick={() => add(type)}>Add</button>
        </div>
      </div>
    );
  };
  return <>{group('category', 'Medicine categories')}{group('specialty', 'Doctor specialties')}</>;
}

/* ---------- Content: edit the CMS pages ---------- */
export function ContentTab() {
  const { toast } = useUI();
  const [pages, setPages] = useState(null);

  const load = async () => {
    const list = await api('/api/cms');
    setPages(await Promise.all(list.map((p) => api('/api/cms/' + p.slug))));
  };
  useEffect(() => { load(); }, []);

  const edit = (slug, key, value) =>
    setPages(pages.map((p) => (p.slug === slug ? { ...p, [key]: value } : p)));

  const save = async (page) => {
    try {
      await api('/api/admin/cms/' + page.slug, { method: 'PUT', body: { title: page.title, body: page.body } });
      toast('Page saved');
      load();
    } catch (err) { toast(err.message, true); }
  };

  if (!pages) return <Empty>Loading…</Empty>;
  return (
    <>
      {pages.map((p) => (
        <div className="card" style={{ marginBottom: 16 }} key={p.slug}>
          <label htmlFor={`t_${p.slug}`}>Title</label>
          <input id={`t_${p.slug}`} value={p.title} onChange={(e) => edit(p.slug, 'title', e.target.value)} />
          <label htmlFor={`b_${p.slug}`}>Body</label>
          <textarea id={`b_${p.slug}`} rows="6" value={p.body} onChange={(e) => edit(p.slug, 'body', e.target.value)} />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="meta">/{p.slug} · updated {p.updated_at}</span>
            <button className="btn small" onClick={() => save(p)}>Save</button>
          </div>
        </div>
      ))}
    </>
  );
}
