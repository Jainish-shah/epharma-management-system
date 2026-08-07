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
│        Client (SPA — HTML/CSS/JavaScript)       │
│  Landing · Patient · Doctor · Pharmacy · Admin  │
└──────────────────────┬──────────────────────────┘
                       │ HTTPS / JSON
┌──────────────────────▼──────────────────────────┐
│           REST API (Node.js + Express)          │
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
| Single Express server serving both API and static frontend | One process, one port; simplest deployable unit for this scope |
| Token-based auth (server-stored session tokens) | Stateless clients, instant revocation on logout |
| SQLite (built-in `node:sqlite`) | Zero-config, transactional, no native deps; clean migration path to PostgreSQL for production scale |
| Vanilla JS SPA, no build step | No toolchain risk; runs anywhere Node ≥ 22.5 runs |
| Role checks in one `auth(...roles)` middleware | RBAC enforced at the route boundary, single point of audit |
| Event bus abstraction (in-process default, Kafka opt-in) | Decouples producers (orders/payments) from consumers (notifications/receipts); scales to multiple instances via Kafka without changing business logic |
| Payment-provider façade (Stripe / Razorpay) | Uniform verified-checkout flow; provider is a config switch, mock providers keep it fully testable |

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

### 3.5 Admin Dashboard (ERP)
- KPI overview: users by role, pending approvals, order count, revenue, appointments.
- Document/registration approval queue; full user registry.
- Read access to all orders and appointments for monitoring.

## 4. Database Schema

| Table | Key fields | Notes |
|---|---|---|
| `users` | role, email (unique), password_hash, status, role-specific columns | Single-table design; `status` drives approval flow |
| `tokens` | token → user_id | Session store |
| `medicines` | pharmacy_id, name, category, price, stock | Per-pharmacy inventory |
| `orders` | patient_id, pharmacy_id, status, type, total, prescription_id | Total computed server-side |
| `order_items` | order_id, medicine_id, name, price, qty | Price snapshotted at purchase |
| `appointments` | patient_id, doctor_id, slot, status | |
| `prescriptions` | patient_id, doctor_id, appointment_id, kind, content | `uploaded` (patient) or `eprescription` (doctor) |
| `notifications` | user_id, message, read | Feeds every status change |
| `payments` | provider_order_id, patient_id, amount, status, order_id | Razorpay-shaped intent; order created only after signature verify |
| `messages` | appointment_id, sender_id, body | Teleconsultation chat, party-scoped |
| `refill_reminders` | patient_id, medicine_name, due_date, notified | Materialised into notifications when due |
| `taxonomy` | type (category/specialty), name | Admin-managed lists; advisory `<datalist>` suggestions |
| `cms_pages` | slug, title, body | Admin-editable FAQ / Terms / Privacy |

## 5. API Architecture

RESTful JSON over ~20 endpoints in six groups: auth, public catalog, inventory (pharmacy), orders, appointments/prescriptions, notifications, and admin. Full endpoint table in [README.md](../README.md). Conventions: `POST` creates, `PATCH` transitions state, role scoping happens server-side from the token (never from client-supplied IDs).

## 6. Data Privacy & Security

- **RBAC** on every route via middleware; ownership checks on every mutation (pharmacy can only advance its own orders, doctor only its own appointments).
- **Password hashing:** scrypt with per-user salt and timing-safe comparison.
- **Server-side validation:** prices and totals computed from DB, stock checked transactionally, status transitions whitelisted.
- **Roadmap for HIPAA/GDPR alignment:** encrypt prescription blobs at rest, audit logging, data-retention policy, consent capture at registration (Phase 5).

## 7. Development Plan (13 July – 17 September 2026)

| Phase | Dates | Scope | Status |
|---|---|---|---|
| 1. Analysis & prototype | 13–19 Jul | System analysis, this plan, working end-to-end prototype (all 4 roles) | ✅ Done |
| 2. Core module hardening | 20 Jul – 2 Aug | OTP-verified patient registration, document upload for doctor & pharmacy verification, input-validation & error-handling pass, coding standards | ✅ Done (wk 1 of 2) |
| 3. Commerce & consultation | 3–16 Aug | Payment-gateway integration (Razorpay sandbox, signature-verified), teleconsultation chat + Jitsi video, refill reminders | ✅ Done |
| 4. Admin ERP & reporting | 17–30 Aug | Revenue/consultation/order reports, CMS pages, SMS/email gateway (Kafka consumer), category & specialty management | ✅ Done |
| 5. Performance & security | 31 Aug – 13 Sep | PostgreSQL migration, encryption at rest, audit logs, load testing, accessibility pass | Planned |
| 6. Deployment & handover | 14–17 Sep | Production deployment, final documentation, demo & handover | Planned |

## 8. Testing Strategy

- **Now:** automated end-to-end API suite (`npm test`) — 45 assertions covering the full patient→pharmacy→doctor→admin workflow, OTP registration, RBAC denial cases, stock/oversell edge cases, Stripe payment verification (+ tamper rejection), the payment→notification event chain, teleconsultation chat access control, refill reminders, admin reporting aggregates, taxonomy management, and CMS editing. Runs against a throwaway database.
- **Later phases:** browser automation for critical UI flows, load test before deployment.

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Scope creep across 9 modules in 10 weeks | Working vertical slice already delivered; each phase ships independently demoable increments |
| Third-party integration delays (payments, SMS) | All integrations stubbed behind clean seams; demo flows work without them |
| SQLite limits under concurrent load | Schema is plain SQL; PostgreSQL migration scheduled in Phase 5 before deployment |
