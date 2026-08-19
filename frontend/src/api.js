/* The single gateway to the Django backend.
 * Attaches the session token, sends/receives JSON, and turns an error response into a thrown
 * Error so callers can `try/catch` and show a toast. */

let token = localStorage.getItem('token');

export function getToken() {
  return token;
}

export function setSession(data) {
  token = data.token;
  localStorage.setItem('token', data.token);
  localStorage.setItem('user', JSON.stringify(data.user));
}

export function clearSession() {
  token = null;
  localStorage.clear();
}

export function storedUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null');
  } catch {
    return null;
  }
}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
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

/* ---------- small shared helpers ---------- */

export const money = (n) => '₹' + Number(n).toFixed(2);

// Read a File into a base64 data URL (prescription / verification-document uploads).
export const fileToDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
