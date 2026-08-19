/* Root component.
 *
 * Structure:  <Nav/>  +  either <Landing/> (logged out) or <Dashboard/> (logged in).
 * The dashboard is a tab bar whose active tab renders one of the tab components.
 * Session (token + user) lives in localStorage via api.js; `user` in state drives the whole tree.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, clearSession, money, setSession, storedUser } from './api';
import { Empty, useUI } from './ui';
import { LoginForm, RegisterForm } from './auth';
import { CartModal, DoctorsTab, MedicinesTab, RefillsTab } from './tabs/patient';
import { AppointmentsTab, OrdersTab, PrescriptionsTab } from './tabs/shared';
import { EarningsTab, InventoryTab, ProfileTab } from './tabs/provider';
import { ApprovalsTab, CatalogTab, ContentTab, OverviewTab, ReportsTab, UsersTab } from './tabs/admin';

// Which tabs each role sees once logged in.
const TABS = {
  patient: ['Medicines', 'Doctors', 'My Orders', 'My Appointments', 'Prescriptions', 'Refills'],
  doctor: ['Appointments', 'My Prescriptions', 'Earnings', 'Profile'],
  pharmacy: ['Inventory', 'Orders'],
  admin: ['Overview', 'Reports', 'Approvals', 'Users', 'Orders', 'Appointments', 'Catalog', 'Content'],
};

export default function App() {
  const { openModal, closeModal, toast } = useUI();
  const [user, setUser] = useState(storedUser);
  const [config, setConfig] = useState({ paymentProvider: 'stripe', mock: true });
  const [cart, setCart] = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);      // bumping this re-mounts the active tab

  // Which payment provider is live (drives the checkout label).
  useEffect(() => { api('/api/config').then(setConfig).catch(() => {}); }, []);

  const onAuthed = useCallback((data) => {
    setSession(data);
    setUser(data.user);
    setActiveTab(null);
    closeModal();
  }, [closeModal]);

  const logout = async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* token already invalid */ }
    clearSession();
    setUser(null);
    setCart([]);
    setActiveTab(null);
  };

  const goHome = () => { closeModal(); setActiveTab(null); };
  const refresh = () => setReloadKey((k) => k + 1);

  return (
    <>
      <a href="#app" className="skip-link">Skip to main content</a>
      <Nav user={user} onHome={goHome} onLogout={logout}
           onLogin={() => openModal(<LoginForm onLoggedIn={onAuthed} />)}
           onRegister={() => openModal(<RegisterForm onRegistered={onAuthed} />)} />

      <main id="app" tabIndex={-1}>
        {user
          ? <Dashboard key={reloadKey} user={user} setUser={setUser} activeTab={activeTab}
                       setActiveTab={setActiveTab} cart={cart} setCart={setCart}
                       config={config} refresh={refresh} />
          : <Landing onNeedLogin={(what) => { toast(`Please log in to ${what}`); openModal(<LoginForm onLoggedIn={onAuthed} />); }} />}
      </main>

      {/* Floating cart button — patients only, once something is in the cart */}
      {user?.role === 'patient' && cart.length > 0 && (
        <button className="cart-fab"
                onClick={() => openModal(<CartModal cart={cart} setCart={setCart} user={user} config={config}
                                                    onOrdered={() => { setActiveTab('My Orders'); refresh(); }} />)}>
          🛒 Cart ({cart.reduce((s, c) => s + c.qty, 0)}) · {money(cart.reduce((s, c) => s + c.price * c.qty, 0))}
        </button>
      )}
    </>
  );
}

/* ---------- Navbar: brand, notifications bell, session controls ---------- */
function Nav({ user, onHome, onLogin, onRegister, onLogout }) {
  const [notifs, setNotifs] = useState(null);   // null = panel closed
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!user) { setUnread(0); return; }
    api('/api/notifications').then((n) => setUnread(n.filter((x) => !x.read).length)).catch(() => {});
  }, [user]);

  const toggle = async () => {
    if (notifs) { setNotifs(null); return; }
    const list = await api('/api/notifications');
    setNotifs(list);
    await api('/api/notifications/read', { method: 'POST' }).catch(() => {});
    setUnread(0);
  };

  return (
    <nav className="navbar" aria-label="Main">
      <button className="brand" onClick={onHome} aria-label="E-Pharma home">
        💊 E-Pharma<span aria-hidden="true">+</span>
      </button>
      <div className="nav-right">
        {user ? (
          <>
            <button className="bell" onClick={toggle} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
              🔔{unread > 0 && <span className="count">{unread}</span>}
            </button>
            <span className="nav-user">{user.name}</span>
            <span className="badge-role">{user.role}</span>
            <button className="btn secondary small" onClick={onLogout}>Logout</button>
          </>
        ) : (
          <>
            <button className="btn secondary" onClick={onLogin}>Login</button>
            <button className="btn" onClick={onRegister}>Register</button>
          </>
        )}
      </div>
      {notifs && (
        <div className="notif-panel">
          {notifs.length === 0 && <div className="notif-item">No notifications yet</div>}
          {notifs.map((n) => (
            <div className={'notif-item' + (n.read ? '' : ' unread')} key={n.id}>
              {n.message}<div className="time">{n.created_at}</div>
            </div>
          ))}
        </div>
      )}
    </nav>
  );
}

/* ---------- Landing page (logged out) ---------- */
function Landing({ onNeedLogin }) {
  const { openModal } = useUI();
  const [meds, setMeds] = useState([]);
  const [docs, setDocs] = useState([]);
  const [pages, setPages] = useState([]);
  const [search, setSearch] = useState('');

  const load = (q = '') => {
    api('/api/medicines?search=' + encodeURIComponent(q)).then(setMeds).catch(() => {});
    api('/api/doctors?search=' + encodeURIComponent(q)).then(setDocs).catch(() => {});
  };
  useEffect(() => { load(); api('/api/cms').then(setPages).catch(() => {}); }, []);

  const viewPage = async (slug) => {
    const p = await api('/api/cms/' + slug);
    openModal(<CmsPage page={p} />);
  };

  return (
    <>
      <div className="hero">
        <h1>Medicines &amp; doctors, one platform</h1>
        <p>Order medicines from verified pharmacies, consult trusted doctors online, and manage your health records — all in one place.</p>
        <div className="quick-links">
          <button className="btn" onClick={() => onNeedLogin('book appointments')}>📅 Book Appointment</button>
          <button className="btn ghost" onClick={() => onNeedLogin('order medicines')}>🛒 Order Medicine</button>
        </div>
      </div>

      <div className="search-bar">
        <input aria-label="Search medicines or doctors" placeholder="Search medicines or doctors…"
               value={search} onChange={(e) => setSearch(e.target.value)}
               onKeyDown={(e) => e.key === 'Enter' && load(search)} />
        <button className="btn" onClick={() => load(search)}>Search</button>
      </div>

      <div className="container">
        <div className="section-title">Available medicines</div>
        <div className="grid">
          {meds.length === 0 && <Empty>No medicines found</Empty>}
          {meds.map((m) => (
            <div className="card" key={m.id}>
              <h3>{m.name}</h3>
              <div className="meta">{m.category} · {m.store_name}</div>
              <div className="row">
                <span className="price">{money(m.price)}</span>
                <button className="btn small" onClick={() => onNeedLogin('order medicines')}>Add to cart</button>
              </div>
            </div>
          ))}
        </div>

        <div className="section-title" style={{ marginTop: 32 }}>Our doctors</div>
        <div className="grid">
          {docs.length === 0 && <Empty>No doctors found</Empty>}
          {docs.map((d) => (
            <div className="card" key={d.id}>
              <h3>{d.name}</h3>
              <div className="meta">{d.specialization} · {d.qualification}</div>
              <div className="row">
                <span className="price">{money(d.fee)} / visit</span>
                <button className="btn small" onClick={() => onNeedLogin('book appointments')}>Book</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <footer style={{ textAlign: 'center', padding: 24, borderTop: '1px solid var(--border)', color: 'var(--muted)', fontSize: 13 }}>
        E-Pharma ·{' '}
        {pages.map((p, i) => (
          <span key={p.slug}>
            {i > 0 && ' · '}
            <a href="#" onClick={(e) => { e.preventDefault(); viewPage(p.slug); }}
               style={{ color: 'var(--primary-dark)', margin: '0 8px' }}>{p.title}</a>
          </span>
        ))}
      </footer>
    </>
  );
}

function CmsPage({ page }) {
  const { closeModal } = useUI();
  return (
    <div>
      <h2>{page.title}</h2>
      <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6, maxHeight: '60vh', overflowY: 'auto' }}>{page.body}</div>
      <div className="actions"><button className="btn secondary" onClick={closeModal}>Close</button></div>
    </div>
  );
}

/* ---------- Dashboard shell (logged in): tab bar + active tab ---------- */
function Dashboard({ user, setUser, activeTab, setActiveTab, cart, setCart, config, refresh }) {
  const tabs = TABS[user.role] || [];
  const current = activeTab && tabs.includes(activeTab) ? activeTab : tabs[0];

  // Providers can be logged in but not yet approved — show a status banner instead of the tabs.
  if (user.status === 'pending') {
    return <div className="container"><div className="banner">⏳ Your {user.role} account is <b>awaiting admin approval</b>. You'll be notified once approved.</div></div>;
  }
  if (user.status === 'rejected') {
    return <div className="container"><div className="banner">❌ Your account was rejected by the admin. Contact support.</div></div>;
  }

  const render = () => {
    switch (current) {
      case 'Medicines': return <MedicinesTab cart={cart} setCart={setCart} />;
      case 'Doctors': return <DoctorsTab onBooked={() => setActiveTab('My Appointments')} />;
      case 'My Orders':
      case 'Orders': return <OrdersTab user={user} />;
      case 'My Appointments':
      case 'Appointments': return <AppointmentsTab user={user} />;
      case 'Prescriptions':
      case 'My Prescriptions': return <PrescriptionsTab user={user} />;
      case 'Refills': return <RefillsTab />;
      case 'Earnings': return <EarningsTab user={user} />;
      case 'Profile': return <ProfileTab user={user} onUpdated={(u) => { setUser(u); localStorage.setItem('user', JSON.stringify(u)); }} />;
      case 'Inventory': return <InventoryTab />;
      case 'Overview': return <OverviewTab />;
      case 'Reports': return <ReportsTab />;
      case 'Approvals': return <ApprovalsTab />;
      case 'Users': return <UsersTab />;
      case 'Catalog': return <CatalogTab />;
      case 'Content': return <ContentTab />;
      default: return <Empty>Nothing here</Empty>;
    }
  };

  return (
    <div className="container">
      <div className="tabs" role="tablist" aria-label={`${user.role} sections`}>
        {tabs.map((t) => (
          <button key={t} className={'tab' + (t === current ? ' active' : '')} role="tab"
                  aria-selected={t === current} onClick={() => setActiveTab(t)}>{t}</button>
        ))}
      </div>
      <div id="tabContent" role="tabpanel" aria-live="polite">{render()}</div>
    </div>
  );
}
