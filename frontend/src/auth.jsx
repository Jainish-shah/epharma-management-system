/* Login and registration dialogs.
 * Registration adapts to the chosen role: patients verify an OTP, doctors and pharmacies supply
 * professional details and upload verification documents for admin approval. */
import { useEffect, useState } from 'react';
import { api, fileToDataUrl } from './api';
import { ModalActions, useUI } from './ui';

export function LoginForm({ onLoggedIn }) {
  const { closeModal, toast } = useUI();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/login', { method: 'POST', body: { email: email.trim(), password } });
      onLoggedIn(data);
      toast(`Welcome, ${data.user.name}`);
    } catch (err) {
      toast(err.message, true);
    }
  };

  return (
    <form onSubmit={submit}>
      <h2>Welcome back</h2>
      <div className="sub">Log in to E-Pharma</div>
      <label htmlFor="loginEmail">Email</label>
      <input id="loginEmail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
      <label htmlFor="loginPass">Password</label>
      <input id="loginPass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <ModalActions>
        <button type="button" className="btn secondary" onClick={closeModal}>Cancel</button>
        <button type="submit" className="btn">Login</button>
      </ModalActions>
      <div className="demo-creds">
        <b>Demo accounts</b><br />
        admin@epharma.com / admin123<br />
        asha@epharma.com / doctor123<br />
        store@medplus.com / pharma123<br />
        priya@gmail.com / patient123
      </div>
    </form>
  );
}

const BLANK = {
  name: '', email: '', phone: '', password: '', address: '', otp: '',
  qualification: '', specialization: '', fee: '', availability: '',
  store_name: '', license_no: '', gstin: '',
};

/* Consent must be given actively: the box starts unticked and the server rejects a registration
 * without it, so a pre-ticked box or a silent default is not possible. */
function ConsentBox({ checked, onChange, onViewPolicy }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '14px 0 4px' }}>
      <input id="regConsent" type="checkbox" checked={checked} onChange={onChange}
             style={{ width: 'auto', marginTop: 3 }} />
      <label htmlFor="regConsent" style={{ margin: 0, fontWeight: 400, color: 'var(--text)', fontSize: 13 }}>
        I have read and accept the{' '}
        <a href="#" onClick={(e) => { e.preventDefault(); onViewPolicy(); }} style={{ color: 'var(--primary-dark)' }}>
          Privacy Policy
        </a>
        , and I consent to my personal and health data being processed to provide this service.
      </label>
    </div>
  );
}

export function RegisterForm({ onRegistered }) {
  const { closeModal, toast, openModal } = useUI();
  const [role, setRole] = useState('patient');
  const [f, setF] = useState(BLANK);
  const [otpHint, setOtpHint] = useState('');
  const [files, setFiles] = useState({});          // { label: File }
  const [specialties, setSpecialties] = useState([]);
  const [consent, setConsent] = useState(false);   // must be ticked by the user, never pre-set

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const pickFile = (label) => (e) => setFiles({ ...files, [label]: e.target.files[0] });

  // Managed specialty suggestions for doctors (advisory — free text is still accepted).
  useEffect(() => {
    if (role !== 'doctor') return;
    api('/api/taxonomy?type=specialty').then(setSpecialties).catch(() => {});
  }, [role]);

  const sendOtp = async () => {
    try {
      const data = await api('/api/register/send-otp', { method: 'POST', body: { email: f.email.trim() } });
      // Demo mode returns the code so it can be shown; a real gateway delivers it out-of-band.
      setOtpHint(data.devOtp ? `Demo OTP sent: ${data.devOtp}` : 'OTP sent to your email/mobile.');
      toast('OTP sent');
    } catch (err) {
      toast(err.message, true);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    try {
      // Read any chosen verification documents into data URLs.
      const documents = {};
      for (const [label, file] of Object.entries(files)) {
        if (!file) continue;
        if (file.size > 2 * 1024 * 1024) throw new Error(`${label} must be under 2 MB`);
        documents[label] = await fileToDataUrl(file);
      }
      const data = await api('/api/register', {
        method: 'POST',
        body: { role, ...f, consent, documents: Object.keys(documents).length ? documents : undefined },
      });
      onRegistered(data);
      toast(data.user.status === 'pending' ? 'Registered! Awaiting admin approval.' : 'Account created!');
    } catch (err) {
      toast(err.message, true);
    }
  };

  return (
    <form onSubmit={submit}>
      <h2>Create account</h2>
      <div className="sub">Doctors and pharmacies upload verification documents and need admin approval before going live.</div>

      <label htmlFor="regRole">I am a</label>
      <select id="regRole" value={role} onChange={(e) => setRole(e.target.value)}>
        <option value="patient">Patient</option>
        <option value="doctor">Doctor</option>
        <option value="pharmacy">Pharmacy</option>
      </select>

      <label htmlFor="regName">Full name</label>
      <input id="regName" value={f.name} onChange={set('name')} />
      <label htmlFor="regEmail">Email</label>
      <input id="regEmail" type="email" value={f.email} onChange={set('email')} />
      <label htmlFor="regPhone">Mobile</label>
      <input id="regPhone" value={f.phone} onChange={set('phone')} />
      <label htmlFor="regPass">Password (min 6 chars)</label>
      <input id="regPass" type="password" value={f.password} onChange={set('password')} />

      {role === 'patient' && (
        <>
          <label htmlFor="regAddress">Address</label>
          <input id="regAddress" value={f.address} onChange={set('address')} placeholder="Delivery address" />
          <label htmlFor="regOtp">Verify email / mobile (OTP)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input id="regOtp" value={f.otp} onChange={set('otp')} placeholder="6-digit code" />
            <button type="button" className="btn secondary" style={{ whiteSpace: 'nowrap' }} onClick={sendOtp}>Send OTP</button>
          </div>
          {otpHint && <div className="meta" style={{ marginTop: 4 }}>{otpHint}</div>}
        </>
      )}

      {role === 'doctor' && (
        <>
          <label htmlFor="regQual">Qualification</label>
          <input id="regQual" value={f.qualification} onChange={set('qualification')} placeholder="MBBS, MD" />
          <label htmlFor="regSpec">Specialization</label>
          <input id="regSpec" list="specList" value={f.specialization} onChange={set('specialization')} placeholder="Cardiology" />
          <datalist id="specList">{specialties.map((s) => <option key={s.id} value={s.name} />)}</datalist>
          <label htmlFor="regFee">Consultation fee (₹)</label>
          <input id="regFee" type="number" value={f.fee} onChange={set('fee')} placeholder="500" />
          <label htmlFor="regAvail">Availability slots (comma separated)</label>
          <input id="regAvail" value={f.availability} onChange={set('availability')} placeholder="Mon 10:00, Wed 15:00" />
          <label htmlFor="docDegree">Upload degree certificate (image)</label>
          <input id="docDegree" type="file" accept="image/*" onChange={pickFile('Degree certificate')} />
          <label htmlFor="docLicense">Upload medical license (image)</label>
          <input id="docLicense" type="file" accept="image/*" onChange={pickFile('Medical license')} />
        </>
      )}

      {role === 'pharmacy' && (
        <>
          <label htmlFor="regStore">Store name</label>
          <input id="regStore" value={f.store_name} onChange={set('store_name')} placeholder="MedPlus Pharmacy" />
          <label htmlFor="regLicense">Drug license no.</label>
          <input id="regLicense" value={f.license_no} onChange={set('license_no')} placeholder="DL-MH-12345" />
          <label htmlFor="regGstin">GSTIN</label>
          <input id="regGstin" value={f.gstin} onChange={set('gstin')} placeholder="27ABCDE1234F1Z5" />
          <label htmlFor="regAddr2">Store address</label>
          <input id="regAddr2" value={f.address} onChange={set('address')} placeholder="Shop address" />
          <label htmlFor="docDrug">Upload drug license (image)</label>
          <input id="docDrug" type="file" accept="image/*" onChange={pickFile('Drug license')} />
          <label htmlFor="docGst">Upload GSTIN proof (image)</label>
          <input id="docGst" type="file" accept="image/*" onChange={pickFile('GSTIN proof')} />
        </>
      )}

      <ConsentBox
        checked={consent}
        onChange={(e) => setConsent(e.target.checked)}
        onViewPolicy={async () => {
          try {
            const p = await api('/api/cms/privacy');
            openModal(<PolicyView page={p} onBack={() => openModal(<RegisterForm onRegistered={onRegistered} />)} />);
          } catch { toast('Could not load the privacy policy', true); }
        }}
      />

      <ModalActions>
        <button type="button" className="btn secondary" onClick={closeModal}>Cancel</button>
        {/* disabled until consent is given, so the requirement is obvious before submitting */}
        <button type="submit" className="btn" disabled={!consent}>Register</button>
      </ModalActions>
    </form>
  );
}

function PolicyView({ page, onBack }) {
  return (
    <div>
      <h2>{page.title}</h2>
      <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6, maxHeight: '60vh', overflowY: 'auto' }}>
        {page.body}
      </div>
      <ModalActions>
        <button className="btn secondary" onClick={onBack}>Back to registration</button>
      </ModalActions>
    </div>
  );
}
