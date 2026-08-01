# E-Pharma Management System

Integrated platform connecting patients, doctors and pharmacies — prescription-based ordering,
teleconsultation booking, inventory management and admin oversight.

**Stack:** Node.js + Express (REST API) · SQLite via built-in `node:sqlite` (zero config) · Vanilla JS SPA (no build step) · event streaming (in-process bus, optional Apache Kafka) · Stripe/Razorpay payments (sandbox)

## Run

Requires Node.js ≥ 22.5 (uses the built-in SQLite module).

```bash
npm install
npm start
# open http://localhost:3000
```

The database (`epharma.db`) is created and seeded with demo data on first run.
Delete the `epharma.db*` files to reset to a fresh seed.

## Test

```bash
npm test
```

End-to-end API suite (35 assertions): full patient → pharmacy → doctor → admin workflow,
OTP-verified registration, input-validation rejections, RBAC denials, stock/oversell edge cases,
payment signature verification, teleconsultation chat, and refill reminders.
Uses a throwaway database — never touches demo data.
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

## API overview

| Area | Endpoints |
|---|---|
| Payments | `POST /api/payments/create` (patient — payment intent for the cart) |
| Consultation | `GET/POST /api/appointments/:id/messages`, `GET /api/appointments/:id/room` (patient/doctor party only) |
| Refills | `GET /api/refills` (patient) |
| Config (public) | `GET /api/config` (active payment provider) |

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
| `REFILL_DAYS` | `30` | days after an order before a refill reminder is due |

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
