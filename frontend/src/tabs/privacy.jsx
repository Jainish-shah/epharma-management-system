/* Privacy tab — lets a person exercise their data rights themselves rather than having to email
 * support: see what consent is recorded, download everything held about them, and erase the account. */
import { useState } from 'react';
import { api, clearSession } from '../api';
import { ModalActions, useUI } from '../ui';

export function PrivacyTab({ user, onErased }) {
  const { openModal, toast } = useUI();
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    try {
      const data = await api('/api/me/data');
      // Build the file in the browser — the export never has to be stored on a server.
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `epharma-my-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('Your data has been downloaded');
    } catch (e) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h3>Your consent</h3>
        <div className="meta" style={{ marginTop: 6 }}>
          {user.consent_version
            ? <>You accepted privacy policy <b>v{user.consent_version}</b> on {String(user.consent_at).slice(0, 10)}.</>
            : <>No consent record found on this account.</>}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3>Download your data</h3>
        <div className="meta" style={{ marginTop: 6, marginBottom: 12 }}>
          Get a copy of everything we hold about you — your account, orders, appointments,
          prescriptions and consultation messages — as a JSON file.
        </div>
        <button className="btn" onClick={download} disabled={busy}>
          {busy ? 'Preparing…' : 'Download my data'}
        </button>
      </div>

      <div className="card" style={{ borderColor: 'var(--danger)' }}>
        <h3>Delete your account</h3>
        <div className="meta" style={{ marginTop: 6, marginBottom: 12 }}>
          Your personal details are permanently erased and you will not be able to sign in again.
          Orders, payments and prescriptions must be kept for the legally required period, but they
          are stripped of anything identifying you.
        </div>
        <button className="btn danger" onClick={() => openModal(<DeleteAccount onErased={onErased} />)}>
          Delete my account
        </button>
      </div>
    </>
  );
}

function DeleteAccount({ onErased }) {
  const { closeModal, toast } = useUI();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  // Two deliberate barriers on an irreversible action: the password, and typing the word DELETE.
  const ready = password && confirm.trim().toUpperCase() === 'DELETE';

  const erase = async () => {
    setBusy(true);
    try {
      await api('/api/me/delete', { method: 'DELETE', body: { password } });
      closeModal();
      clearSession();
      toast('Your account has been erased');
      onErased();
    } catch (e) {
      toast(e.message, true);
      setBusy(false);
    }
  };

  return (
    <div>
      <h2>Delete your account</h2>
      <div className="sub">This cannot be undone.</div>
      <div className="banner" style={{ marginTop: 10 }}>
        Your name, contact details and documents are erased and your sign-in is disabled. Orders and
        prescriptions are retained in a form that no longer identifies you, because pharmacies are
        required to keep those records.
      </div>
      <label htmlFor="delPass">Confirm your password</label>
      <input id="delPass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <label htmlFor="delConfirm">Type DELETE to confirm</label>
      <input id="delConfirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="DELETE" />
      <ModalActions>
        <button className="btn secondary" onClick={closeModal}>Cancel</button>
        <button className="btn danger" onClick={erase} disabled={!ready || busy}>
          {busy ? 'Erasing…' : 'Erase my account'}
        </button>
      </ModalActions>
    </div>
  );
}
