# E-Pharma Management System — Handover

Final handover document for the Techmentee E-Pharma Management System.

**Prepared by:** Jainish Nikul Shah, Software Engineer
**Project duration:** 13 July 2026 – 17 September 2026

---

## 1. What was delivered

An integrated ERP platform connecting **patients**, **doctors**, **pharmacies** and **administrators**:
prescription-based medicine ordering with real payment verification, teleconsultation (chat and
video), inventory and stock management, medical-record handling with encryption at rest, and a full
administrative reporting, catalog and content suite.

All six planned phases are complete.

| Phase | Scope | Status |
|---|---|---|
| 1 | Project understanding & system analysis | ✅ |
| 2 | Core module hardening (OTP, document verification, validation) | ✅ |
| 3 | Commerce & consultation (payments, Kafka events, chat/video, refills) | ✅ |
| 4 | Admin ERP & reporting (reports, SMS/email gateway, catalog, CMS) | ✅ |
| 5 | Performance & security (PostgreSQL, encryption, audit log, load test, accessibility) | ✅ |
| 6 | Deployment & handover | ✅ |

---

## 2. Technology

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite, built into `public/` |
| Backend | Python 3.11+ / Django 5.2, plain views returning JSON (no ORM, no DRF) |
| Database | SQLite (zero-config demo) or PostgreSQL (production) — one code path |
| Payments | Stripe or Razorpay, server-side verification, mock gateway by default |
| Events | In-process bus, or Apache Kafka when configured |
| Server | gunicorn, containerised with Docker |

---

## 3. Repository map

| Path | Contents |
|---|---|
| `api/views.py` | Every REST endpoint (documented per endpoint) |
| `api/db.py` | Schema, demo seed, and the query/get/run/transaction helpers |
| `api/crypto.py` | Encryption at rest for medical records |
| `api/payments.py` | Stripe/Razorpay façade with signature verification |
| `api/events.py` | Event bus (in-process / Kafka) |
| `epharma_site/` | Django project: settings (incl. production security), URLs, WSGI |
| `frontend/src/` | React source — see the README for the file-by-file breakdown |
| `public/` | **Generated** React build, committed so the app runs with Python alone |
| `test.sh` | 49-assertion end-to-end API suite |
| `smoketest.sh` | Read-only post-deployment verification |
| `loadtest.sh` | Throughput/latency benchmark |
| `Dockerfile`, `docker-compose.prod.yml`, `.env.example` | Deployment |
| `docs/` | Analysis & development plan, coding standards, runbook, status reports |

---

## 4. Running it

**Locally (no configuration needed):**

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python manage.py runserver 127.0.0.1:3000 --noreload
```

**Production:** see [deployment-runbook.md](deployment-runbook.md).

**Changing the UI** requires Node:

```bash
npm install --prefix frontend
npm run dev --prefix frontend      # hot reload, proxies /api to Django
npm run build --prefix frontend    # rebuild public/ — commit the result
```

---

## 5. Verification

| Command | What it proves |
|---|---|
| `bash test.sh` | 49 end-to-end assertions across all four roles — passes on **both** SQLite and PostgreSQL |
| `bash smoketest.sh <url>` | A live deployment is healthy, serving, authenticating and sending security headers |
| `bash loadtest.sh` | Throughput and latency (measured locally: ~2.1–2.9k req/s, p95 ≤ 19 ms) |

The test suite covers the money and security paths specifically: payment signature verification and
tamper rejection, stock/oversell handling, role-based access denials, OTP enforcement, and an
assertion that reads the raw database column to prove stored prescriptions are ciphertext.

---

## 6. Demo accounts

| Role | Email | Password |
|---|---|---|
| Admin | admin@epharma.com | admin123 |
| Doctor (approved) | asha@epharma.com | doctor123 |
| Pharmacy (approved) | store@medplus.com | pharma123 |
| Patient | priya@gmail.com | patient123 |

Two further accounts (a doctor and a pharmacy) are seeded in the **pending** state so the admin
approval flow, including document verification, can be demonstrated.

**These accounts must be removed before the platform serves real users** — their passwords are
published in this repository.

---

## 7. Outstanding decisions

These need a business decision and credentials; the code paths already exist and are tested against
mocks, so each is a configuration change rather than development work.

| Decision | Needed for |
|---|---|
| Hosting environment and managed PostgreSQL instance | Deployment |
| Payment provider to license — Stripe or Razorpay (both integrated) | Real payments |
| SMS/email provider — Twilio, AWS SES or similar | Real notification delivery |
| Whether to provision managed Kafka | Multi-container event fan-out |

## 8. Recommended next work

1. **Compliance:** data-retention policy, consent capture at registration, and encryption-key
   rotation — the remaining items for full HIPAA/GDPR alignment.
2. **Scheduled jobs:** move refill-reminder evaluation out of the request path into a cron/worker.
3. **Real-time consultation:** replace chat polling with Server-Sent Events or WebSockets.
4. **Frontend tests:** the API is covered end to end; component-level tests for the React app would
   close the remaining gap.
5. **Observability:** ship logs and metrics to a monitoring service and alert on the health endpoint.
