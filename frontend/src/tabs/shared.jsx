/* Tabs shared by several roles: orders, appointments (+ teleconsultation), prescriptions.
 * Each one renders differently depending on `user.role`, exactly as the API scopes the data. */
import { useEffect, useRef, useState } from 'react';
import { api, money, fileToDataUrl } from '../api';
import { Empty, ModalActions, Pill, useUI } from '../ui';

/* ---------- Orders (patient sees theirs, pharmacy theirs + actions, admin all) ---------- */
export function OrdersTab({ user }) {
  const { openModal, toast } = useUI();
  const [orders, setOrders] = useState(null);
  const load = () => api('/api/orders').then(setOrders);
  useEffect(() => { load(); }, []);

  const advance = async (id) => {
    try {
      await api(`/api/orders/${id}`, { method: 'PATCH' });
      toast('Order status updated');
      load();
    } catch (err) { toast(err.message, true); }
  };

  // The next step in the pipeline, branching on delivery vs pickup.
  const nextLabel = (o) => ({
    pending: 'Start preparing',
    preparing: o.type === 'delivery' ? 'Mark shipped' : 'Mark ready',
    shipped: 'Mark delivered',
    ready: 'Mark picked up',
  }[o.status]);

  if (!orders) return <Empty>Loading…</Empty>;
  if (!orders.length) return <Empty>No orders yet</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th><th>{user.role === 'patient' ? 'Pharmacy' : 'Patient'}</th><th>Items</th>
            <th>Type</th><th>Total</th><th>Status</th><th>Rx</th>
            {user.role === 'pharmacy' && <th>Action</th>}
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td>{o.id}<br /><span className="meta" style={{ fontSize: 11 }}>{o.created_at}</span></td>
              <td>{user.role === 'patient' ? o.store_name : o.patient_name}</td>
              <td>{o.items.map((i) => <div key={i.id}>{i.name} × {i.qty}</div>)}</td>
              <td>{o.type}{o.type === 'delivery' && o.address && <><br /><span className="meta" style={{ fontSize: 11 }}>{o.address}</span></>}</td>
              <td>{money(o.total)}</td>
              <td><Pill status={o.status} /></td>
              <td>{o.prescription
                ? <button className="btn secondary small" onClick={() => openModal(<RxViewer title={`Prescription — order #${o.id}`} content={o.prescription} />)}>View</button>
                : '—'}</td>
              {user.role === 'pharmacy' && (
                <td>{nextLabel(o) ? <button className="btn small" onClick={() => advance(o.id)}>{nextLabel(o)}</button> : '✓'}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RxViewer({ title, content }) {
  const { closeModal } = useUI();
  const isImage = String(content).startsWith('data:image');
  return (
    <div>
      <h2>{title}</h2>
      {isImage
        ? <img className="rx-img" style={{ maxWidth: '100%' }} src={content} alt={title} />
        : <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{content}</pre>}
      <ModalActions><button className="btn secondary" onClick={closeModal}>Close</button></ModalActions>
    </div>
  );
}

/* ---------- Appointments (+ consultation entry point) ---------- */
export function AppointmentsTab({ user }) {
  const { openModal, toast } = useUI();
  const [appts, setAppts] = useState(null);
  const load = () => api('/api/appointments').then(setAppts);
  useEffect(() => { load(); }, []);

  const setStatus = async (id, status) => {
    try {
      await api(`/api/appointments/${id}`, { method: 'PATCH', body: { status } });
      toast(`Appointment ${status}`);
      load();
    } catch (err) { toast(err.message, true); }
  };

  const showActions = user.role === 'doctor' || user.role === 'patient';
  const consultable = (a) => ['confirmed', 'completed'].includes(a.status);

  if (!appts) return <Empty>Loading…</Empty>;
  if (!appts.length) return <Empty>No appointments yet</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>#</th><th>{user.role === 'doctor' ? 'Patient' : 'Doctor'}</th><th>Slot</th><th>Status</th>
            {showActions && <th>Actions</th>}</tr>
        </thead>
        <tbody>
          {appts.map((a) => (
            <tr key={a.id}>
              <td>{a.id}</td>
              <td>{user.role === 'doctor' ? a.patient_name : `${a.doctor_name} (${a.specialization})`}</td>
              <td>{a.slot}</td>
              <td><Pill status={a.status} /></td>
              {showActions && (
                <td>
                  {consultable(a) && (
                    <button className="btn secondary small" onClick={() => openModal(<Consultation apptId={a.id} user={user} />)}>💬 Consult</button>
                  )}
                  {user.role === 'doctor' && a.status === 'pending' && (
                    <>
                      <button className="btn small" onClick={() => setStatus(a.id, 'confirmed')}>Accept</button>{' '}
                      <button className="btn danger small" onClick={() => setStatus(a.id, 'rejected')}>Reject</button>
                    </>
                  )}
                  {user.role === 'doctor' && a.status === 'confirmed' && (
                    <> <button className="btn small" onClick={() => openModal(<WritePrescription apptId={a.id} onDone={load} />)}>Write e-prescription</button></>
                  )}
                  {!consultable(a) && user.role === 'patient' && '—'}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- Teleconsultation: chat thread + Jitsi video room ---------- */
function Consultation({ apptId, user }) {
  const { closeModal, toast } = useUI();
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const boxRef = useRef();

  const load = async () => {
    try { setMessages(await api(`/api/appointments/${apptId}/messages`)); } catch { /* modal closed */ }
  };

  // Poll for new messages while the dialog is open (SSE/WebSocket is the production upgrade).
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [apptId]);

  useEffect(() => { if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight; }, [messages]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    try {
      await api(`/api/appointments/${apptId}/messages`, { method: 'POST', body: { body } });
      load();
    } catch (err) { toast(err.message, true); }
  };

  const joinVideo = async () => {
    try {
      const { url } = await api(`/api/appointments/${apptId}/room`);
      window.open(url, '_blank');
      toast('Opening secure video room…');
    } catch (err) { toast(err.message, true); }
  };

  return (
    <div>
      <h2>Teleconsultation</h2>
      <div className="sub">Appointment #{apptId} · secure chat &amp; video</div>
      <div ref={boxRef} aria-live="polite" style={{
        height: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8,
        padding: 10, marginBottom: 8, fontSize: 13, background: 'var(--bg)',
      }}>
        {messages.length === 0 && <div className="meta">No messages yet — say hello 👋</div>}
        {messages.map((m) => (
          <div key={m.id} style={{ marginBottom: 8 }}>
            <b style={{ color: m.sender_id === user.id ? 'var(--primary-dark)' : 'var(--text)' }}>{m.sender_name}</b>
            <span className="meta" style={{ fontSize: 11 }}> · {m.created_at}</span><br />{m.body}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input aria-label="Message" placeholder="Type a message…" value={text}
               onChange={(e) => setText(e.target.value)}
               onKeyDown={(e) => e.key === 'Enter' && send()} />
        <button className="btn" onClick={send}>Send</button>
      </div>
      <ModalActions>
        <button className="btn secondary" onClick={joinVideo}>🎥 Join video call</button>
        <button className="btn secondary" onClick={closeModal}>Close</button>
      </ModalActions>
    </div>
  );
}

function WritePrescription({ apptId, onDone }) {
  const { closeModal, toast } = useUI();
  const [content, setContent] = useState('');
  const submit = async () => {
    try {
      await api('/api/prescriptions', { method: 'POST', body: { appointment_id: apptId, content } });
      closeModal();
      toast('e-Prescription uploaded, consultation completed');
      onDone();
    } catch (err) { toast(err.message, true); }
  };
  return (
    <div>
      <h2>e-Prescription</h2>
      <div className="sub">Completing this consultation uploads the prescription to the patient.</div>
      <label htmlFor="rxContent">Prescription</label>
      <textarea id="rxContent" rows="6" value={content} onChange={(e) => setContent(e.target.value)}
                placeholder={'Rx\n1. Paracetamol 500mg — 1 tab twice daily × 5 days\n2. ...'} />
      <ModalActions>
        <button className="btn secondary" onClick={closeModal}>Cancel</button>
        <button className="btn" onClick={submit}>Upload prescription</button>
      </ModalActions>
    </div>
  );
}

/* ---------- Prescriptions (patient can also upload one) ---------- */
export function PrescriptionsTab({ user }) {
  const { toast } = useUI();
  const [rxs, setRxs] = useState(null);
  const [file, setFile] = useState(null);
  const load = () => api('/api/prescriptions').then(setRxs);
  useEffect(() => { load(); }, []);

  const upload = async () => {
    try {
      if (!file) throw new Error('Choose an image first');
      if (file.size > 2 * 1024 * 1024) throw new Error('Image must be under 2 MB');
      await api('/api/prescriptions/upload', { method: 'POST', body: { content: await fileToDataUrl(file) } });
      toast('Prescription uploaded');
      load();
    } catch (err) { toast(err.message, true); }
  };

  if (!rxs) return <Empty>Loading…</Empty>;
  return (
    <>
      {user.role === 'patient' && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', maxWidth: 480 }}>
          <input aria-label="Prescription image" type="file" accept="image/*" onChange={(e) => setFile(e.target.files[0])} />
          <button className="btn" onClick={upload}>Upload prescription</button>
        </div>
      )}
      {rxs.length === 0 ? <Empty>No prescriptions yet</Empty> : (
        <div className="grid">
          {rxs.map((r) => (
            <div className="card" key={r.id}>
              <h3>{r.kind === 'eprescription' ? '🩺 e-Prescription' : '📄 Uploaded'}</h3>
              <div className="meta">
                {r.doctor_name && `By ${r.doctor_name} · `}
                {user.role === 'doctor' && `For ${r.patient_name} · `}
                {r.created_at}
              </div>
              {String(r.content).startsWith('data:image')
                ? <img className="rx-img" src={r.content} alt="Prescription document" />
                : <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13 }}>{r.content}</pre>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
