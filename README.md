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
| `frontend/src/tabs/admin.jsx` | Overview, reports, approvals, users, catalog, CMS, retention |
| `frontend/src/tabs/privacy.jsx` | Consent record, data download, account erasure |

## Test

```bash
bash test.sh
```

End-to-end API suite (106 assertions): full patient → pharmacy → doctor → admin workflow,
OTP-verified registration, input-validation rejections, RBAC denials, stock/oversell edge cases,
payment signature verification, teleconsultation chat, refill reminders, admin reports,
taxonomy management, CMS editing, consent enforcement, data export, erasure, retention,
GST invoice numbering and tax extraction, invoice immutability, delivery assignment and the
stock ledger, rate limiting (429, Retry-After, health exemption), token revocation on logout, and
invoice uniqueness under concurrent checkout. Passes on both SQLite and PostgreSQL. Uses a throwaway
database — never touches demo data.

Every assertion runs even after one fails; the failures are listed together at the end and the
script exits non-zero. Against PostgreSQL the suite resets the schema first, so a run is repeatable
— point it only at a throwaway database.
[docs/runbook.md](docs/runbook.md) is the end-to-end operations runbook — running, verifying,
walking the full business flow, deploying, operating, troubleshooting and recovery.
See also [docs/system-analysis-and-development-plan.md](docs/system-analysis-and-development-plan.md)
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
  `PAYMENT_PROVIDER` (default `stripe`) and go live by setting real keys — see [api/payments.py](api/payments.py).
- **Event streaming (Kafka)** — orders, payments and notifications are published to topics and handled by
  independent consumers (notification service persists messages; payment service issues receipts), so
  producers are decoupled from consumers. Runs on an in-process bus by default; set `KAFKA_BROKERS` to
  stream through Apache Kafka (see [api/events.py](api/events.py), [docker-compose.yml](docker-compose.yml)).
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


### Phase 7 additions (compliance & data governance)

- **Consent capture** — registration requires explicit, unticked-by-default consent; the accepted
  privacy-policy version and timestamp are stored on the account and recorded in the audit trail.
- **Right of access / portability** — `GET /api/me/data` returns everything held about the caller,
  decrypted, and the Privacy tab downloads it as a JSON file.
- **Right to erasure** — `DELETE /api/me/delete` overwrites every identifying field, disables the
  login and ends all sessions. Orders, payments and prescriptions are *retained in de-identified
  form*, because pharmacies are normally required to keep them; the reasoning and the single place
  to change it are in [api/compliance.py](api/compliance.py).
- **Data retention** — configurable windows per record type, purged by `POST /api/admin/retention/purge`
  (intended for a nightly job) and visible to admins in the Retention tab.
- **Encryption-key rotation** — `EPHARMA_ENC_KEY_OLD` lets a retired key still decrypt while the new
  key encrypts; `python manage.py rotate_encryption_key` re-encrypts existing rows.

### Phase 8 additions (fulfilment & billing)

- **GST tax invoices** — every paid order raises a tax invoice with a serial that is consecutive
  per pharmacy and reset each financial year (`INV/2026-27/0007`), as CGST Rule 46(b) requires.
  MRP is GST-inclusive, so the invoice *extracts* the tax rather than adding it: the patient pays
  exactly the cart total, and the invoice shows the taxable value, CGST and SGST behind it.
  `GET /api/orders/:id/invoice`; printable to PDF from the browser.
- **Immutable line snapshots** — `order_items` now stores the GST rate alongside the price, so
  re-slabbing a product never rewrites an invoice that has already been issued.
- **Delivery assignment** — a pharmacy hands each delivery order to its own rider (name + contact)
  or to a partner courier (company + tracking number) via `POST /api/orders/:id/delivery`. Nothing
  can be marked *shipped* until it has a carrier, and the patient sees who is holding the order.
- **Stock in/out ledger** — `stock_moves` records every movement with its reason (opening, sale,
  restock, return, damage, expiry, adjustment), the resulting balance and who caused it.
  `GET/POST /api/medicines/:id/stock`. Editing the stock field directly is still allowed but is
  logged as an adjustment, so no change to a stock level goes unexplained.

## API overview

| Area | Endpoints |
|---|---|
| Payments | `POST /api/payments/create` (patient — payment intent for the cart) |
| Billing | `GET /api/orders/:id/invoice` (patient/pharmacy/admin — GST tax invoice) |
| Fulfilment | `POST /api/orders/:id/delivery` (pharmacy — assign own rider or partner courier) |
| Stock ledger | `GET/POST /api/medicines/:id/stock` (pharmacy — movement history, stock in/out) |
| Consultation | `GET/POST /api/appointments/:id/messages`, `GET /api/appointments/:id/room` (patient/doctor party only) |
| Refills | `GET /api/refills` (patient) |
| Privacy (self-service) | `GET /api/me/data` (export), `DELETE /api/me/delete` (erasure) |
| Retention | `POST /api/admin/retention/purge` (admin) |
| Config (public) | `GET /api/config` (active payment provider) |
| Reports | `GET /api/admin/reports` (admin) |
| Catalog | `GET /api/taxonomy?type=`, `POST/DELETE /api/admin/taxonomy[/:id]` (admin write) |
| CMS | `GET /api/cms`, `GET /api/cms/:slug`, `PUT /api/admin/cms/:slug` (admin write) |

### Full endpoint reference

| Area | Endpoints |
|---|---|
| Auth | `POST /api/register/send-otp`, `POST /api/register`, `POST /api/login`, `POST /api/logout`, `GET/PATCH /api/me`, `POST /api/me/documents` |
| Catalog (public) | `GET /api/medicines?search=`, `GET /api/doctors?search=` |
| Inventory (pharmacy) | `GET /api/my-medicines`, `POST/PATCH/DELETE /api/medicines[/:id]`, `GET/POST /api/medicines/:id/stock` |
| Orders | `POST /api/orders` (patient), `GET /api/orders` (role-scoped), `PATCH /api/orders/:id` (pharmacy advances status), `POST /api/orders/:id/delivery` (assign carrier), `GET /api/orders/:id/invoice` |
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
| `EPHARMA_ENC_KEY_OLD` | _(unset)_ | comma-separated retired keys, kept only while re-encrypting after a key rotation |
| `POLICY_VERSION` | `1.0` | privacy-policy version recorded against each consent |
| `RETAIN_OTPS_DAYS` / `RETAIN_TOKENS_DAYS` / `RETAIN_NOTIFICATIONS_DAYS` / `RETAIN_AUDIT_DAYS` | `1` / `30` / `180` / `365` | data-retention windows |
| `REFILL_DAYS` | `30` | days after an order before a refill reminder is due |
| `RATE_LIMIT_ENABLED` | `1` | set `0` to switch rate limiting off (load testing) |
| `RATE_LIMIT` / `RATE_LIMIT_AUTH` | `120` / `10` | requests per window per client — general tier / auth tier |
| `RATE_LIMIT_WINDOW` | `60` | rate-limit window in seconds |
| `DJANGO_TRUST_PROXY` | `0` | trust `X-Forwarded-For` for the client IP — only behind a trusted proxy |
| `DATABASE_URL` | _(unset)_ | `postgres://user:pass@host/db` — run on PostgreSQL instead of SQLite |
| `EPHARMA_ENC_KEY` | demo key | secret used to encrypt medical records at rest — **set this in production** |

**Run with real Kafka:**

```bash
docker compose up -d                          # local single-node Kafka broker
.venv/bin/pip install kafka-python            # optional; imported only when KAFKA_BROKERS is set
KAFKA_BROKERS=localhost:9092 .venv/bin/python manage.py runserver 127.0.0.1:3000 --noreload
```

`GET /api/health` reports `"events":"kafka"` once the broker is connected. If the client is missing
or the broker is unreachable the app logs the reason and falls back to the in-process bus rather than
failing to start.

## Load testing

Locust is a test tool, not a runtime dependency, so install it separately:

```bash
.venv/bin/pip install locust
```

```bash
bash loadtest-locust.sh                 # 100 users, 60s, 4 workers
bash loadtest-locust.sh 200 90s 8       # users, duration, workers
bash db-contention-test.sh              # database concurrency and connection-refusal behaviour
```

`loadtest-locust.sh` runs three scenarios against a throwaway gunicorn instance: realistic traffic
with think time, saturation to find the throughput ceiling, and an abusive client to show excess
load being shed as 429. Scenarios live in [locustfile.py](locustfile.py) and can also be driven
interactively (`locust -f locustfile.py --host ...` for the web UI on :8089).

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
- **Invoices assume an intra-state supply** (CGST + SGST). An inter-state order would carry a single
  IGST line instead, which needs a state code on both parties — the registration form does not collect
  one yet. The split lives in one function (`api/billing.py`).
- **Delivery tracking is a record, not a live feed** — the courier and tracking reference are stored and
  shown, but the app does not call the courier's API for location updates.
- **Rate-limit counters live in process memory**, so with N gunicorn workers the effective limit is
  N x the configured number. It fails permissive rather than wrongly locking a user out. Move the
  counter to Redis when the limit must be exact across workers or containers — only `_hit()` changes.
- **There is no database connection pool.** `api/db.py` opens one connection per worker process and
  serialises access with a lock, so the unit of database concurrency is the worker process. See the
  runbook for what this means operationally.
