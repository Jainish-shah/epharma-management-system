# E-Pharma Management System
## System Analysis & Development Plan

**Prepared by:** Jainish Nikul Shah, Software Engineer
**Project:** Techmentee — E-Pharma Management System
**Duration:** 13 July 2026 – 17 September 2026
**Phase 1 deliverable** (13–19 July 2026)

---

## 1. Project Overview

An integrated ERP platform connecting **patients**, **doctors**, and **medical stores (pharmacies)** with **admin oversight**. Core capabilities: prescription-based medicine ordering, teleconsultation booking, inventory and stock management, medical record handling, and role-based administration.

## 2. System Architecture

```
┌─────────────────────────────────────────────────┐
│         Client (React SPA — Vite build)         │
│  Landing · Patient · Doctor · Pharmacy · Admin  │
└──────────────────────┬──────────────────────────┘
                       │ HTTPS / JSON
┌──────────────────────▼──────────────────────────┐
│           REST API (Python + Django)            │
│  Auth (token) · RBAC middleware · Business logic│
└───────┬───────────────────────────────┬─────────┘
        │                               │ publish
        │                    ┌──────────▼───────────────────────┐
        │                    │  Event bus (in-process / Kafka)  │
        │                    │  topics: orders · payments ·     │
        │                    │  appointments · notifications    │
        │                    └──────────┬───────────────────────┘
        │                               │ consumers
        │                    ┌──────────▼───────────────────────┐
        │                    │ notification svc · payment svc · │
        │                    │ analytics (subscribe to topics)  │
        │                    └──────────┬───────────────────────┘
        │ external                      │
┌───────▼──────────┐          ┌─────────▼───────────────────────┐
│ Stripe / Razorpay│          │          SQLite database         │
│ (sandbox/live)   │          │ users · medicines · orders ·     │
└──────────────────┘          │ order_items · appointments ·     │
                              │ prescriptions · notifications ·  │
                              │ payments · messages · refills    │
                              └──────────────────────────────────┘
```

**Design decisions**

| Decision | Rationale |
|---|---|
| Single Django server serving both API and static frontend | One process, one port; simplest deployable unit for this scope |
| Token-based auth (server-stored session tokens) | Stateless clients, instant revocation on logout |
| Dual-backend data layer: SQLite by default, PostgreSQL via `DATABASE_URL` (raw driver, not the ORM) | Zero-config for demos, production-grade database for deployment — one code path, verified by the same test suite on both |
| React (Vite) SPA, built into `public/` and served by Django | Component model for a UI of this size; the build output is committed so the app still runs with Python alone (one process, one port, no Node needed to deploy) |
| Role checks in one `require_auth(*roles)` helper | RBAC enforced at the view boundary, single point of audit |
| Event bus abstraction (in-process default, Kafka opt-in) | Decouples producers (orders/payments) from consumers (notifications/receipts); scales to multiple instances via Kafka without changing business logic |
| Payment-provider façade (Stripe / Razorpay) | Uniform verified-checkout flow; provider is a config switch, mock providers keep it fully testable |
| Invoice serials from a per-pharmacy counter row, not the order id | GST requires a series that is consecutive per supplier and unique per financial year; the global order id would leave holes in each pharmacy's series |
| Price *and* GST rate snapshotted onto `order_items` | An issued tax invoice is a historical document — editing the catalogue must never rewrite it |
| Invoice rendered as HTML, printed to PDF by the browser | A statutory document with no PDF dependency to license, patch or keep alive |
| Stock levels backed by an append-only movement ledger | The current level is derivable and explainable: every unit on the shelf traces to a movement with a reason and an actor |

## 3. Core Module Analysis

### 3.1 User Registration & Authentication
- Three self-service registration flows (patient / doctor / pharmacy) with role-specific fields; passwords hashed with scrypt + per-user salt.
- Doctors and pharmacies enter `pending` state — hidden from patients and locked out of their dashboards until admin approval.
- Every API route behind token auth; role whitelist per route.

### 3.2 Patient Management
- Profile with address and contact details.
- Medicine search across approved pharmacies; single-pharmacy cart; delivery or pickup.
- Prescription upload (image) at checkout or standalone; full order and appointment history; notification feed.

### 3.3 Doctor Management
- Qualification, specialization, consultation fee, and availability slots on profile.
- Appointment pipeline: pending → confirmed/rejected → completed (auto-completed when the e-prescription is issued).
- e-Prescriptions delivered to the patient's record; earnings computed from completed consultations.

### 3.4 Pharmacy Management
- Store profile with drug license and GSTIN (verified by admin).
- Inventory CRUD with stock tracking and low-stock warnings.
- Order pipeline with type-aware transitions: pending → preparing → shipped → delivered (delivery) or ready → picked up (pickup). Stock is validated and decremented atomically inside a DB transaction at order time.
- **Delivery assignment (Phase 8):** each delivery order is handed to the store's own rider or to a partner courier before it can be marked shipped; the patient sees the carrier and tracking reference.
- **Stock in/out ledger (Phase 8):** restocks, returns and write-offs are booked with a reason rather than by overwriting the level, and every movement records the balance it produced.
- **GST invoicing (Phase 8):** every paid order raises a tax invoice on the store's own serial series, printable to PDF.

### 3.5 Admin Dashboard (ERP)
- KPI overview: users by role, pending approvals, order count, revenue, appointments.
- Document/registration approval queue; full user registry.
- Read access to all orders and appointments for monitoring.

## 4. Database Schema

| Table | Key fields | Notes |
|---|---|---|
| `users` | role, email (unique), password_hash, status, role-specific columns, consent_version/consent_at, anonymised_at | Single-table design; `status` drives approval flow; consent and erasure recorded here (Phase 7) |
| `tokens` | token → user_id, created_at | Session store; `created_at` lets idle sessions be purged |
| `medicines` | pharmacy_id, name, category, price, stock | Per-pharmacy inventory |
| `orders` | patient_id, pharmacy_id, status, type, total, prescription_id, invoice_no/invoice_at, delivery_mode/courier_name/rider_phone/tracking_no | Total computed server-side; invoice raised at order time; carrier recorded before dispatch (Phase 8) |
| `order_items` | order_id, medicine_id, name, price, qty, gst_rate | Price **and tax rate** snapshotted at purchase, so an issued invoice never changes |
| `appointments` | patient_id, doctor_id, slot, status | |
| `prescriptions` | patient_id, doctor_id, appointment_id, kind, content | `uploaded` (patient) or `eprescription` (doctor) |
| `notifications` | user_id, message, read | Feeds every status change |
| `payments` | provider_order_id, patient_id, amount, status, order_id | Razorpay-shaped intent; order created only after signature verify |
| `messages` | appointment_id, sender_id, body | Teleconsultation chat, party-scoped |
| `refill_reminders` | patient_id, medicine_name, due_date, notified | Materialised into notifications when due |
| `taxonomy` | type (category/specialty), name | Admin-managed lists; advisory `<datalist>` suggestions |
| `cms_pages` | slug, title, body | Admin-editable FAQ / Terms / Privacy |
| `audit_log` | user_id, actor, action, detail | Security trail: logins, approvals, orders, prescriptions, consent, erasure, stock movements |
| `stock_moves` | medicine_id, pharmacy_id, delta, balance, reason, actor_id | Append-only stock ledger: opening, sale, restock, return, damage, expiry, adjustment (Phase 8) |
| `invoice_seq` | pharmacy_id, fy, last_no | Per-supplier, per-financial-year invoice counter; the row lock serialises concurrent checkouts (Phase 8) |

## 5. API Architecture

RESTful JSON over ~20 endpoints in six groups: auth, public catalog, inventory (pharmacy), orders, appointments/prescriptions, notifications, and admin. Full endpoint table in [README.md](../README.md). Conventions: `POST` creates, `PATCH` transitions state, role scoping happens server-side from the token (never from client-supplied IDs).

## 6. Data Privacy & Security

- **RBAC** on every route via middleware; ownership checks on every mutation (pharmacy can only advance its own orders, doctor only its own appointments).
- **Password hashing:** scrypt with per-user salt and timing-safe comparison.
- **Server-side validation:** prices and totals computed from DB, stock checked transactionally, status transitions whitelisted.
- **Encryption at rest (Phase 5):** prescriptions, consultation messages and verification documents are encrypted with Fernet (AES-CBC + HMAC) before storage, so a stolen database contains ciphertext.
- **Audit logging (Phase 5):** logins (including failed attempts), registrations, approvals, orders, prescriptions and CMS edits are recorded in `audit_log` and reviewable by admins.
- **Consent (Phase 7):** registration requires explicit consent; the policy version and timestamp are stored and audited.
- **Subject rights (Phase 7):** each person can export everything held about them and request erasure; erasure overwrites identifying fields while retaining de-identified medical/financial records for their statutory period.
- **Retention (Phase 7):** per-record-type windows, purged on a schedule.
- **Key rotation (Phase 7):** a retired key can still decrypt while the new key encrypts, with a command to re-encrypt existing rows.
- **Financial record integrity (Phase 8):** invoice serials come from a locked counter (never reused, never gapped) and every invoice line is a snapshot, so a customer's tax document cannot be altered after issue by editing the catalogue.

## 7. Development Plan (13 July – 17 September 2026)

| Phase | Dates | Scope | Status |
|---|---|---|---|
| 1. Analysis & prototype | 13–19 Jul | System analysis, this plan, working end-to-end prototype (all 4 roles) | ✅ Done |
| 2. Core module hardening | 20 Jul – 2 Aug | OTP-verified patient registration, document upload for doctor & pharmacy verification, input-validation & error-handling pass, coding standards | ✅ Done (wk 1 of 2) |
| 3. Commerce & consultation | 3–16 Aug | Payment-gateway integration (Razorpay sandbox, signature-verified), teleconsultation chat + Jitsi video, refill reminders | ✅ Done |
| 4. Admin ERP & reporting | 17–30 Aug | Revenue/consultation/order reports, CMS pages, SMS/email gateway (Kafka consumer), category & specialty management | ✅ Done |
| 5. Performance & security | 31 Aug – 13 Sep | PostgreSQL support (dual-backend data layer), encryption at rest, audit logging, load testing, accessibility pass | ✅ Done |
| 6. Deployment & handover | 14–17 Sep | Production deployment, final documentation, demo & handover | In progress |

Delivered week by week, the phases above map onto these working increments:

| Week | Dates | Increment | Status |
|---|---|---|---|
| Phase 5 | 10–16 Aug | PostgreSQL, encryption at rest, audit log, load & accessibility testing | ✅ Done |
| Phase 6 | 17–23 Aug | Production deployment package (Docker, gunicorn, smoke tests) + React rewrite | ✅ Done |
| Phase 7 | 24–30 Aug | Compliance & data governance (consent, access, erasure, retention, key rotation) | ✅ Done |
| Phase 8 | 31 Aug – 6 Sep | Fulfilment & billing (GST invoices, delivery assignment, stock ledger) | ✅ Done |
| Phase 9 | 31 Aug – 6 Sep | Reliability & operations (rate limiting, load testing, test hardening, runbook) | ✅ Done |
| Phase 10 | 7–13 Sep | Remaining workflow items and final hardening | Planned |
| Phase 11 | 14–17 Sep | Final documentation, demo and handover | Planned |

## 8. Testing Strategy

- **Now:** automated end-to-end API suite (`bash test.sh`) — 106 assertions, passing on **both SQLite and PostgreSQL**, plus a load-test script (`bash loadtest.sh`). Covering the full patient→pharmacy→doctor→admin workflow, OTP registration, RBAC denial cases, stock/oversell edge cases, Stripe payment verification (+ tamper rejection), the payment→notification event chain, teleconsultation chat access control, refill reminders, admin reporting aggregates, taxonomy management, CMS editing, encryption-at-rest verification (asserts the raw database column is ciphertext), the audit trail, GST invoice numbering and tax extraction, invoice immutability under a catalogue change, the dispatch-without-a-carrier block, and the stock ledger. Runs against a throwaway database.
- **Later phases:** browser automation for critical UI flows; production smoke tests after deployment.

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Scope creep across 9 modules in 10 weeks | Working vertical slice already delivered; each phase ships independently demoable increments |
| Third-party integration delays (payments, SMS) | All integrations stubbed behind clean seams; demo flows work without them |
| SQLite limits under concurrent load | Schema is plain SQL; PostgreSQL migration scheduled in Phase 5 before deployment |
