# E-Pharma Management System

Integrated platform connecting patients, doctors and pharmacies — prescription-based ordering,
teleconsultation booking, inventory management and admin oversight.

**Stack:** Node.js + Express (REST API) · SQLite via built-in `node:sqlite` (zero config) · Vanilla JS SPA (no build step)

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

End-to-end API suite (26 assertions): full patient → pharmacy → doctor → admin workflow,
OTP-verified registration, input-validation rejections, RBAC denials, stock/oversell edge cases.
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
2. **Patient** (priya@gmail.com): browse medicines → add to cart → checkout with optional
   prescription image → book a doctor appointment from the Doctors tab.
3. **Pharmacy** (store@medplus.com): see the new order notification → advance it
   (pending → preparing → shipped → delivered) → manage inventory (add/edit/delete, low-stock warning).
4. **Doctor** (asha@epharma.com): accept the appointment → write an e-prescription
   (marks consultation completed) → check Earnings tab.
5. **Patient again**: notifications for order status + prescription; view the e-prescription.
6. **Register** a new doctor or pharmacy → shows "awaiting approval" state.
7. **Admin** (admin@epharma.com): Overview stats → approve the pending registration →
   monitor all orders and appointments.

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

## API overview

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

## Deliberate simplifications (current scope)

- Payment gateway and chat/video consultation are stubbed/demo-only — swap in real providers
  (Razorpay/Stripe, WebRTC) in Phase 3. OTP delivery is demo-mode until an SMS/email gateway is wired.
- Prescription and document images stored as data URLs in SQLite — move to file/object storage if sizes grow.
- Single-process SQLite — fine for demo/dev; migrate to Postgres/MySQL for production ERP scale (Phase 5).
