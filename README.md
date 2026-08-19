# E-Pharma Management System

Integrated platform connecting patients, doctors and pharmacies — prescription-based ordering,
teleconsultation booking, inventory management and admin oversight.

**Stack:** **React** (Vite) frontend · **Python + Django** REST API · SQLite / PostgreSQL · event streaming (in-process bus, optional Apache Kafka) · Stripe/Razorpay payments (sandbox)

## Run

Requires Python ≥ 3.11. The React app is pre-built into `public/`, so **no Node is needed to run it**.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python manage.py runserver 127.0.0.1:3000 --noreload
# open http://localhost:3000
```

Django serves both the REST API (`/api/...`) and the built React app. The database (`epharma.db`)
is created and seeded with demo data on first run — delete the `epharma.db*` files to reset.

## Frontend development

The React source lives in `frontend/` (Vite + React 18). Node is only needed to change the UI.

```bash
npm install --prefix frontend          # once
npm run dev --prefix frontend          # hot-reload dev server on :5174, proxies /api to :3000
npm run build --prefix frontend        # rebuild public/ (commit the result)
```

Run Django and `npm run dev` side by side while developing; run the build before committing UI changes.

**Structure**

| Path | Contents |
|---|---|
| `frontend/src/App.jsx` | Root: navbar, landing page, dashboard shell and tab routing |
| `frontend/src/api.js` | Fetch wrapper (auth header, JSON, error handling) + session helpers |
| `frontend/src/ui.jsx` | Toast + modal dialog via React context (`useUI()`) |
| `frontend/src/auth.jsx` | Login and registration dialogs (OTP, document upload) |
| `frontend/src/tabs/patient.jsx` | Medicines, cart & checkout, doctors & booking, refills |
| `frontend/src/tabs/shared.jsx` | Orders, appointments, teleconsultation, prescriptions |
| `frontend/src/tabs/provider.jsx` | Doctor earnings/profile, pharmacy inventory |
| `frontend/src/tabs/admin.jsx` | Overview, reports, approvals, users, catalog, CMS |

## Test

```bash
bash test.sh
```

End-to-end API suite (45 assertions): full patient → pharmacy → doctor → admin workflow,
OTP-verified registration, input-validation rejections, RBAC denials, stock/oversell edge cases,
payment signature verification, teleconsultation chat, refill reminders, admin reports,
taxonomy management, and CMS editing. Uses a throwaway database — never touches demo data.
See [docs/system-analysis-and-development-plan.md](docs/system-analysis-and-development-plan.md)
for the analysis document and development plan, and
[docs/coding-standards.md](docs/coding-standards.md) for the project coding standards.

## Demo accounts

| Role | Email | Password |
|---|---|---|
| Admin | admin@epharma.com | admin123 |
| Doctor (approved) | asha@epharma.com | doctor123 |
| Pharmacy (approved) | store@medplus.com | pharma123 |
| Patient | priya@gmail.com | patient123 |

## Demo script (suggested flow)

1. **Landing page** — search medicines/doctors without logging in.
2. **Patient** (priya@gmail.com): browse medicines → add to cart → checkout via the
   Razorpay (sandbox) payment step → book a doctor appointment from the Doctors tab.
3. **Pharmacy** (store@medplus.com): see the new order notification → advance it
   (pending → preparing → shipped → delivered) → manage inventory (add/edit/delete, low-stock warning).
4. **Doctor** (asha@epharma.com): accept the appointment → open **Consult** (chat + video) →
   write an e-prescription (marks consultation completed) → check Earnings tab.
5. **Patient again**: reply in the consultation chat / join the video call; see order + prescription
   notifications; check the **Refills** tab for the scheduled reorder reminder.
6. **Register** a new doctor or pharmacy (upload verification documents) → shows "awaiting approval".
7. **Admin** (admin@epharma.com): Overview stats → review documents → approve the pending
   registration → monitor all orders and appointments.

## Features implemented (per project workflow doc)

- **Auth & roles** — register/login for Patient, Doctor, Pharmacy; token-based sessions;
  scrypt-hashed passwords; role-based access control on every API route.
- **Approval flow** — doctors and pharmacies start `pending`; admin approves/rejects;
  unapproved providers are hidden from patients and blocked from their dashboards.
- **Patient** — medicine search, cart, delivery/pickup orders with server-side stock check
  and price calculation, prescription image upload, doctor search, slot booking,
  order/appointment history, notifications.
- **Doctor** — accept/reject appointments, e-prescriptions, availability & fee management, earnings.
- **Pharmacy** — inventory CRUD with low-stock warnings, order pipeline
  (pending → preparing → shipped/ready → delivered/picked up), view attached prescriptions.
- **Admin** — stats overview (users, orders, revenue, appointments), user management,
  registration approvals, full order/appointment monitoring.
- **Notifications** — booking confirmations, order status changes, prescription uploads, approval decisions.

### Phase 2 additions (core module hardening)

- **OTP-verified patient registration** — `send-otp` issues a 6-digit code; registration is rejected
  without a matching code. (Demo returns the code in the response / server log; wire a real SMS/email
  gateway in Phase 3.)
- **Verification documents** — doctors upload degree & medical license, pharmacies upload drug license
  & GSTIN proof (at registration or later); admin reviews them in the approval queue before approving.
- **Input validation** — email/phone format, password length, role-specific required fields, and
  non-negative numeric checks on every write endpoint, with clear error messages.
- **Error handling** — malformed JSON, oversized uploads and unknown API routes now return clean JSON errors.

### Phase 3 additions (commerce & consultation)

- **Payments (Stripe / Razorpay)** — provider-neutral checkout: a payment intent is created for the cart,
  then the order is placed only after the server verifies the payment and that the paid amount matches the
  recomputed cart total. Both providers ship a built-in mock (fully testable); pick one with
  `PAYMENT_PROVIDER` (default `stripe`) and go live by setting real keys — see [payments.js](payments.js).
- **Event streaming (Kafka)** — orders, payments and notifications are published to topics and handled by
  independent consumers (notification service persists messages; payment service issues receipts), so
  producers are decoupled from consumers. Runs on an in-process bus by default; set `KAFKA_BROKERS` to
  stream through Apache Kafka (see [events.js](events.js), [docker-compose.yml](docker-compose.yml)).
- **Teleconsultation** — per-appointment chat (backed by the `messages` table, live-polled in the UI)
  and a deterministic, unguessable Jitsi video room per appointment. Opens once the appointment is confirmed;
  only the two parties can access it.
- **Refill reminders** — every ordered medicine schedules a refill reminder (`REFILL_DAYS`, default 30);
  due reminders surface automatically as patient notifications and in the **Refills** tab.

### Phase 4 additions (admin ERP & reporting)

- **Reports** — admin dashboard aggregations (revenue by day, top medicines, revenue by pharmacy,
  order/appointment status breakdowns, consultation totals), rendered as CSS bar charts (no charting library).
- **SMS / email gateway** — a second consumer on the Kafka `notifications` topic delivers every notification
  over email/SMS (fan-out alongside DB persistence). Mock logs by default; set `NOTIFY_CHANNELS=email,sms`
  and wire Twilio/SES to go live.
- **Catalog management** — admin-managed medicine categories & doctor specialties (`taxonomy` table),
  surfaced as `<datalist>` suggestions in the medicine and registration forms (advisory — free text still allowed).
- **CMS pages** — admin-editable FAQ / Terms / Privacy (`cms_pages`), shown as links in the landing footer.

### Phase 5 additions (performance & security)

- **PostgreSQL support** — set `DATABASE_URL=postgres://…` to run on PostgreSQL instead of SQLite.
  One data layer serves both (placeholders, `RETURNING id`, schema types and transactions are
  translated in [api/db.py](api/db.py)); the full test suite passes on **both** backends.
- **Encryption at rest** — prescriptions, consultation messages and verification documents are
  encrypted with Fernet (AES-CBC + HMAC) before they are stored and decrypted on the way out, so a
  stolen database file contains ciphertext. Key from `EPHARMA_ENC_KEY` — see [api/crypto.py](api/crypto.py).
- **Audit logging** — logins (including failures), registrations, approvals, orders, prescriptions
  and CMS edits are written to an `audit_log` table; admins can review it at `GET /api/admin/audit`.
- **Load testing** — `bash loadtest.sh [requests] [concurrency]` benchmarks the hot endpoints with
  ApacheBench (local result: ~2.1–2.9k req/s, p95 ≤ 19 ms, 0 failures on SQLite).
- **Accessibility pass** — skip link, keyboard focus rings (`:focus-visible`), ARIA labels on icon
  buttons, `role="tablist"`/`aria-selected` on dashboard tabs, live regions for toasts and tab
  content, `role="dialog"` + focus management + Escape-to-close on modals, `alt` text on all images,
  and `prefers-reduced-motion` support.

## API overview

| Area | Endpoints |
|---|---|
| Payments | `POST /api/payments/create` (patient — payment intent for the cart) |
| Consultation | `GET/POST /api/appointments/:id/messages`, `GET /api/appointments/:id/room` (patient/doctor party only) |
| Refills | `GET /api/refills` (patient) |
| Config (public) | `GET /api/config` (active payment provider) |
| Reports | `GET /api/admin/reports` (admin) |
| Catalog | `GET /api/taxonomy?type=`, `POST/DELETE /api/admin/taxonomy[/:id]` (admin write) |
| CMS | `GET /api/cms`, `GET /api/cms/:slug`, `PUT /api/admin/cms/:slug` (admin write) |

### Full endpoint reference

| Area | Endpoints |
|---|---|
| Auth | `POST /api/register/send-otp`, `POST /api/register`, `POST /api/login`, `POST /api/logout`, `GET/PATCH /api/me`, `POST /api/me/documents` |
| Catalog (public) | `GET /api/medicines?search=`, `GET /api/doctors?search=` |
| Inventory (pharmacy) | `GET /api/my-medicines`, `POST/PATCH/DELETE /api/medicines[/:id]` |
| Orders | `POST /api/orders` (patient), `GET /api/orders` (role-scoped), `PATCH /api/orders/:id` (pharmacy advances status) |
| Appointments | `POST /api/appointments` (patient), `GET /api/appointments`, `PATCH /api/appointments/:id` (doctor) |
| Prescriptions | `POST /api/prescriptions` (doctor), `POST /api/prescriptions/upload` (patient), `GET /api/prescriptions` |
| Notifications | `GET /api/notifications`, `POST /api/notifications/read` |
| Admin | `GET /api/admin/users`, `PATCH /api/admin/users/:id`, `GET /api/admin/stats` |

## Configuration (environment variables)

All optional — the app runs with sensible defaults and no configuration.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `PAYMENT_PROVIDER` | `stripe` | `stripe` or `razorpay` |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` | mock | live Stripe keys (else mock provider) |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | mock | live Razorpay keys (else mock provider) |
| `KAFKA_BROKERS` | _(unset)_ | e.g. `localhost:9092` — stream events through Kafka instead of the in-process bus |
| `NOTIFY_CHANNELS` | `log` | notification delivery channels: `log`, `email`, `sms` (comma-separated) |
| `REFILL_DAYS` | `30` | days after an order before a refill reminder is due |
| `DATABASE_URL` | _(unset)_ | `postgres://user:pass@host/db` — run on PostgreSQL instead of SQLite |
| `EPHARMA_ENC_KEY` | demo key | secret used to encrypt medical records at rest — **set this in production** |

**Run with real Kafka:**

```bash
docker compose up -d          # local single-node Kafka broker
npm i kafkajs                 # optional dependency, loaded only when KAFKA_BROKERS is set
KAFKA_BROKERS=localhost:9092 npm start
```

## Deliberate simplifications (current scope)

- **Payments** run on a built-in mock provider (Stripe or Razorpay); verification is production-identical,
  so going live is just setting real keys.
- **Event streaming** defaults to an in-process bus (synchronous, single process); real Kafka is opt-in via
  `KAFKA_BROKERS` and demonstrates the multi-consumer, decoupled architecture.
- **Video** uses public `meet.jit.si` (no custom WebRTC signaling/TURN server this phase); **chat** live-updates
  by polling (SSE/WebSocket is the production upgrade).
- **OTP** delivery is demo-mode (code returned/logged) until an SMS/email gateway is wired.
- Prescription and document images stored as data URLs in SQLite — move to file/object storage if sizes grow.
- Single-process SQLite — fine for demo/dev; migrate to Postgres/MySQL for production ERP scale (Phase 5).
