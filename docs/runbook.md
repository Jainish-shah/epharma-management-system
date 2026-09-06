# E-Pharma Management System — Operations Runbook

The single end-to-end guide to this application: what it is, how to run it, how to prove it works,
how to walk the whole business flow, how to deploy and operate it, and what to do when something
breaks.

**Prepared by:** Jainish Nikul Shah, Software Engineer
**Project:** Techmentee — E-Pharma Management System

| If you want to… | Go to |
|---|---|
| Understand what the system does | [1. The system](#1-the-system) |
| Get it running on your machine | [3. Start it](#3-start-it) |
| Prove it works | [4. Verify it](#4-verify-it) |
| Walk the complete business flow | [5. The application, end to end](#5-the-application-end-to-end) |
| Run the admin side | [6. Administration](#6-administration) |
| Put it in production | [7. Deploy](#7-deploy) |
| Keep it running | [8. Operate](#8-operate) |
| Fix a problem | [9. Troubleshooting](#9-troubleshooting) |
| Roll back or restore | [10. Recovery](#10-recovery) |
| Reset or shut it down | [11. Reset and decommission](#11-reset-and-decommission) |

Deeper references, not repeated here: [deployment-runbook.md](deployment-runbook.md) for the full
configuration table, [handover.md](handover.md) for the repository map, and
[system-analysis-and-development-plan.md](system-analysis-and-development-plan.md) for the design.

---

## 1. The system

An integrated ERP platform connecting four kinds of user on one deployment:

| Role | What they do |
|---|---|
| **Patient** | Browses medicines and doctors, orders with a prescription, pays, books consultations, holds their medical records |
| **Doctor** | Sets availability, accepts consultations, runs chat/video sessions, issues e-prescriptions, sees earnings |
| **Pharmacy** | Manages inventory and stock movements, fulfils orders, assigns deliveries, issues GST invoices |
| **Admin** | Verifies and approves providers, monitors everything, manages the catalog and site content, runs reports and data retention |

**How it is put together.** One process serves everything:

```
                  HTTPS
  Browser ──▶ reverse proxy ──▶ gunicorn ──┬──▶ React SPA (pre-built, served as static files)
                                            └──▶ Django REST API  ──┬──▶ SQLite or PostgreSQL
                                                                     ├──▶ event bus (in-process / Kafka)
                                                                     └──▶ Stripe or Razorpay
```

The React frontend is **committed pre-built** into `public/`, so running the application needs Python
only. Node is required solely to change the UI.

**Where things live**

| Path | Contents |
|---|---|
| `api/views.py` | Every REST endpoint |
| `api/db.py` | Schema, demo seed, and the query/get/run/transaction helpers |
| `api/billing.py` | GST invoice numbering and tax calculation |
| `api/compliance.py` | Consent, data export, erasure, retention |
| `api/crypto.py`, `api/payments.py`, `api/events.py` | Encryption at rest, payment façade, event bus |
| `frontend/src/` | React source |
| `public/` | Generated React build — committed |
| `test.sh`, `smoketest.sh`, `loadtest.sh` | Verification |

---

## 2. Prerequisites

| For | You need |
|---|---|
| Running the app | Python ≥ 3.11 |
| Changing the UI | Node ≥ 18 (plus the above) |
| Running the test suite | `curl` and `python3` (both standard on macOS and Linux) |
| Load testing | ApacheBench (`ab`) |
| Production | Docker, PostgreSQL 14+, a TLS certificate, a hostname |

Nothing else. There is no ORM, no build step at runtime, and no external service required to start.

---

## 3. Start it

From a clean clone:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python manage.py runserver 127.0.0.1:3000 --noreload
```

Open **http://localhost:3000**.

On first run the application creates its schema and seeds demo data: 12 medicines, 3 doctors
(2 approved, 1 awaiting approval), 2 pharmacies (1 approved, 1 awaiting approval), 1 patient, and an
admin. An existing database is never re-seeded or altered, so restarts never lose data.

**Confirm it is up:**

```bash
curl -s http://localhost:3000/api/health
```

```json
{"status": "ok", "database": "sqlite", "paymentProvider": "stripe", "events": "in-process"}
```

### Demo accounts

| Role | Email | Password |
|---|---|---|
| Admin | admin@epharma.com | admin123 |
| Doctor (approved) | asha@epharma.com | doctor123 |
| Pharmacy (approved) | store@medplus.com | pharma123 |
| Patient | priya@gmail.com | patient123 |

> **These accounts must be removed before the platform serves real users.** Their passwords are
> published in this repository. See [§11](#11-reset-and-decommission).

### Changing the UI

```bash
npm install --prefix frontend          # once
npm run dev --prefix frontend          # hot-reload on :5174, proxies /api to :3000
npm run build --prefix frontend        # rebuild public/ — commit the result
```

Run Django and the Vite dev server side by side while developing. **Always run the build before
committing a UI change**, or the deployed application will still serve the old interface.

---

## 4. Verify it

Three scripts, three different jobs.

| Command | What it proves | When to run it |
|---|---|---|
| `bash test.sh` | 106 end-to-end assertions across all four roles | Before every commit |
| `bash smoketest.sh <url>` | A live deployment is healthy, serving, authenticating, and sending security headers | After every release |
| `bash loadtest.sh` | Throughput and latency under concurrency (ApacheBench) | Before a capacity decision |
| `bash loadtest-locust.sh` | Concurrent-user behaviour: realistic load, the throughput ceiling, and 429 shedding | Before a capacity or scaling decision |
| `bash db-contention-test.sh` | How database concurrency scales with workers, and what happens when the database refuses a connection | When sizing workers, or after a connection incident |

**`test.sh`** starts the application on a throwaway database and port, so it never touches your
working data. Every assertion runs even after one fails, and the failures are listed together at the
end — fixing them one per run is far slower than seeing them all at once. The script exits non-zero
if any failed. It covers the money and security paths specifically: payment signature verification and
tamper rejection, stock and oversell handling, role-based access denials, OTP enforcement, GST
invoice numbering, invoice immutability, dispatch controls, the stock ledger, consent, data export
and erasure — and it reads a raw database column to prove stored prescriptions are ciphertext.

It passes on **both** SQLite and PostgreSQL. To run it against PostgreSQL:

```bash
DATABASE_URL="postgresql://user:pass@127.0.0.1:5432/epharma_test" bash test.sh
```

The suite drops and recreates the `public` schema before it starts, so a PostgreSQL database can be
reused run after run. (It seeds demo data and then erases one of the accounts, so without that reset
a second run would fail.) **Point it only at a throwaway database** — the reset is destructive.

**`smoketest.sh`** is read-only and safe against production. A non-zero exit means roll back.

---

## 5. The application, end to end

The complete business flow, in the order it happens. Every step below is a real path through the
running system; together they exercise every module. Allow about ten minutes.

### 5.1 Anyone — discover, before signing in

Open the landing page. Search "para" — medicines and doctors filter live. The public catalog shows
only medicines from **approved** pharmacies, and only **approved** doctors.

### 5.2 Patient — register with OTP

**Register → Patient.** Fill in name, email, mobile, password and address, tick the consent box, then
**Send OTP**. In demo mode the code is shown on screen; in production it is delivered by SMS or email.
Enter it and register.

Consent is mandatory: registration is refused without it, and the accepted privacy-policy version and
timestamp are stored on the account and written to the audit trail.

### 5.3 Provider — register and wait for approval

Doctors register with their qualification, specialization, fee and availability; pharmacies with
their store details, drug licence and GSTIN. Both upload verification documents and enter a
**pending** state — invisible to patients and locked out of their own dashboard until an admin
approves them (§6.1).

### 5.4 Patient — order medicine

Add items to the cart, open it, choose **home delivery** or **pickup**, optionally attach a
prescription image, and pay.

What happens on the server, in one transaction:

1. the payment is verified against the provider's signature — an unverified or reused payment is refused;
2. stock is re-checked and decremented;
3. the total is **recomputed from the database** and compared to the amount actually paid, so a tampered cart is rejected;
4. a GST tax invoice is raised on the pharmacy's own serial series;
5. a stock movement is recorded for every line;
6. refill reminders are scheduled and order/payment events are published.

If any step fails the whole transaction rolls back — stock is never left half-decremented.

### 5.5 Patient — the tax invoice

**My Orders** shows the invoice number against the order (for example `INV/2026-27/0002`). Opening it
shows the full tax invoice: seller GSTIN and drug licence, buyer details, line-wise taxable value,
GST rate, CGST and SGST, and a rate-wise summary. **Print / Save PDF** uses the browser's own print
dialog.

Prices are MRP and already contain GST, so the invoice **extracts** the tax rather than adding it —
the total on the invoice is exactly what was paid.

### 5.6 Patient — book a consultation

**Doctors → Book.** Pick a slot from the doctor's availability and confirm. The doctor is notified.

### 5.7 Pharmacy — fulfil the order

Log in as the pharmacy. The bell shows the new-order notification.

1. **Orders → Start preparing.**
2. **Assign delivery** — either the store's own rider (name and contact) or a partner courier (company and tracking number). The patient is notified immediately.
3. **Mark shipped.** This is refused until a carrier has been assigned — nothing leaves the store unattributed.
4. **Mark delivered** (or **ready → picked up** for a pickup order).

### 5.8 Pharmacy — manage stock

**Inventory** lists every medicine with its price, GST slab and stock level, flagging anything below
ten units.

- **Stock** opens the movement ledger: book a quantity with a reason (purchase, customer return, damaged, expired, correction) rather than overwriting the level. Every movement records the resulting balance and who made it.
- **Edit** still allows the level to be typed directly, but that is recorded as an adjustment — no change to a stock level goes unexplained.
- Write-offs larger than the stock on hand are refused.

### 5.9 Doctor — consult and prescribe

Log in as the doctor. **Appointments → Accept**, then **Consult** for the secure chat thread and
video room, and **Write e-prescription** to complete the consultation. The prescription lands in the
patient's records and the doctor's earnings update.

Consultation messages and prescriptions are **encrypted at rest** — the raw database column holds
ciphertext.

### 5.10 Patient — the loop closes

Back as the patient: the bell carries notifications for every status change, the payment receipt with
its invoice number, and the new prescription. **Prescriptions** shows the e-prescription; **Refills**
shows reminders as they come due.

### 5.11 Anyone — their own data

The **Privacy** tab is available to patients, doctors and pharmacies:

- the consent record — which policy version was accepted, and when;
- **Download my data** — everything held about the account, decrypted, as a JSON file;
- **Delete my account** — password-confirmed erasure.

Erasure overwrites every identifying field, disables the login and ends all sessions. Orders,
payments and prescriptions are **retained in de-identified form**, because a pharmacy is normally
required to keep them. The reasoning and the single place to change it are in `api/compliance.py`.

Administrator accounts have no Privacy tab and cannot self-erase — an admin removing themselves
could leave the platform with nobody able to approve providers.

> **Known gap.** The refusal message says "ask another administrator", but no admin-initiated
> erasure endpoint exists — `PATCH /api/admin/users/:id` only approves or rejects. Removing an
> admin account today means deleting the row directly, after confirming another admin exists.
> Whether admins should be able to erase each other is a product decision, not a bug in the code.

---

## 6. Administration

Log in as the admin.

### 6.1 Approvals — the gate

**Approvals** lists pending doctors and pharmacies. **View documents** shows the uploaded degree,
drug licence or GSTIN proof; approve or reject. Nothing a provider offers reaches a patient until
this step is done.

### 6.2 Day-to-day

| Tab | Use |
|---|---|
| **Overview** | Live KPIs — users by role, pending approvals, orders, revenue, appointments |
| **Reports** | Revenue, consultation and order aggregates, top medicines by units |
| **Users** | The full registry across all roles |
| **Orders / Appointments** | Read-only monitoring of every order and consultation |
| **Catalog** | Medicine categories and doctor specialties offered as suggestions across the app |
| **Content** | FAQ, Terms and Privacy pages, edited in place |
| **Retention** | The retention policy, and the purge |

### 6.3 The audit trail

`GET /api/admin/audit` records logins (including failed attempts), registrations, approvals, orders,
prescriptions, consent, stock movements, delivery assignments, erasures and CMS edits. This is the
first place to look when asked who did something.

### 6.4 Data retention

Each record type has a retention window. `POST /api/admin/retention/purge` deletes what has passed
it and reports what it removed. **This is intended to run as a nightly scheduled job** — see §8.5.

---

## 7. Deploy

Full configuration reference: [deployment-runbook.md](deployment-runbook.md). The path itself:

```bash
cp .env.example .env          # then edit it — see below
docker compose -f docker-compose.prod.yml up -d --build
bash smoketest.sh https://epharma.example.com
```

Generate the two secrets before you start:

```bash
python -c "import secrets; print(secrets.token_urlsafe(64))"   # DJANGO_SECRET_KEY
python -c "import secrets; print(secrets.token_urlsafe(48))"   # EPHARMA_ENC_KEY
```

**Go-live checklist**

- [ ] `DJANGO_DEBUG=0` with a unique `DJANGO_SECRET_KEY` — the app refuses to start otherwise
- [ ] `DJANGO_ALLOWED_HOSTS` lists the real hostnames, no wildcard
- [ ] `DATABASE_URL` points at PostgreSQL, and the database is not publicly reachable
- [ ] `EPHARMA_ENC_KEY` is set, held in a secrets manager, and **backed up separately from the database**
- [ ] TLS enforced end to end; `smoketest.sh` reports the HSTS header
- [ ] Demo accounts removed (§11.2)
- [ ] Database backups scheduled, and a restore actually tested
- [ ] Retention purge scheduled (§8.5)

> **Empty is not unset.** Compose passes an unset variable through as an empty string, and the
> application treats an empty value as "not configured" — so a blank `STRIPE_SECRET_KEY` silently
> keeps the sandbox gateway rather than failing loudly. Check `/api/health` after every deploy to
> see which database, payment provider and event bus are actually live.

---

## 8. Operate

### 8.1 Health

Point the load balancer at `GET /api/health`. It returns `200` only when the database answers a
query, `503` otherwise, and reports which backends are in use.

### 8.2 Logs

The application logs to stdout/stderr (`docker compose logs -f web`). Payment, order and
notification-delivery events each log a line, so a failed delivery is visible.

### 8.3 Scaling

Increase gunicorn workers (`--workers`, or `WEB_CONCURRENCY`) — roughly `2 × CPU cores + 1` per
container — or run more containers behind the load balancer.

Invoice numbering and order placement are safe across workers: the invoice counter is incremented
under a row lock inside the order transaction. This was verified with twelve simultaneous checkouts
across four worker processes producing a unique, gap-free series.

### 8.4 Backups

Back up PostgreSQL on your provider's schedule (`pg_dump`). **Back up `EPHARMA_ENC_KEY` separately** —
a database backup is unreadable without it, and there is no recovery path if it is lost.

### 8.5 Scheduled jobs

Two jobs should run on a schedule rather than on request:

| Job | Command / call | Suggested cadence |
|---|---|---|
| Retention purge | `POST /api/admin/retention/purge` (admin token) | Nightly |
| Refill reminders | Currently evaluated when a patient loads notifications | Move `run_due_refills()` to a nightly job |

### 8.6 Rotating the encryption key

Three steps, in this order:

```bash
# 1. move the current secret to EPHARMA_ENC_KEY_OLD, set EPHARMA_ENC_KEY to the new one, deploy.
#    New writes now use the new key; existing rows still open with the old one.

# 2. see what would change
python manage.py rotate_encryption_key --dry-run

# 3. re-encrypt, then remove EPHARMA_ENC_KEY_OLD and redeploy
python manage.py rotate_encryption_key
```

The command only touches rows the current key cannot already read, so it is safe to re-run and safe
to interrupt. A row it cannot read with **any** configured key is reported and skipped rather than
destroyed.

---

### 8.7 Rate limiting and capacity

Every `/api/` route is rate limited per client IP, in two tiers:

| Tier | Covers | Default |
|---|---|---|
| `auth` | `/api/login`, `/api/register*`, `/api/me/delete` | 10 per minute (`RATE_LIMIT_AUTH`) |
| `default` | every other `/api/` route | 120 per minute (`RATE_LIMIT`) |

The window is `RATE_LIMIT_WINDOW` seconds (default 60), and `RATE_LIMIT_ENABLED=0` switches the
whole thing off — do that when load testing, so you measure the service and not the limiter.

`/api/health` is never limited — a throttled health check makes a load balancer pull a healthy
instance out of rotation. Static assets are not limited either; one page load pulls several.

A refused request returns **429** with a JSON body, `Retry-After`, and `RateLimit-Limit` /
`-Remaining` / `-Reset` so a well-behaved client can back off before it is refused.

> **`DJANGO_TRUST_PROXY` matters.** The client IP comes from `REMOTE_ADDR` unless this is set to `1`.
> Behind a load balancer that means every request appears to come from the proxy and the whole
> platform shares one bucket — set it to `1` **only** when a trusted proxy sets `X-Forwarded-For`.
> Trusting that header without a proxy in front lets anyone forge a fresh identity per request and
> bypass the limit entirely.

**Counters are per worker process**, so the effective limit is `workers x limit`. This fails
permissive rather than wrongly locking a user out. Move the counter to Redis when the limit has to
be exact across workers or containers — only `_hit()` in `api/ratelimit.py` changes.

**Measured capacity** (this developer machine, SQLite, gunicorn with keep-alive, 50 saturating
clients):

| Workers | Throughput | p95 | Failures |
|---|---|---|---|
| 1 | ~1,580 req/s | 33 ms | 0 |
| 2 | ~2,810 req/s | 20 ms | 0 |
| 4 | ~3,470 req/s | 16 ms | 0 |
| 8 | ~3,515 req/s | 16 ms | 0 |

Throughput nearly doubles from 1 to 2 workers, gains again at 4, and is flat by 8 — past that point
the machine's cores, not the application, are the limit. Under realistic load (60 users with think
time) the same setup served ~72 req/s at a 10 ms p95, so it is idling. Re-measure on your own
hardware before sizing: `bash db-contention-test.sh`.

> The load harness runs gunicorn with `gthread` workers and keep-alive. With the default `sync`
> workers every request opens a fresh TCP connection, and the *load generator* exhausts its
> ephemeral ports long before the server is stressed — which shows up as thousands of
> `Can't assign requested address` errors that look like server failures and are not. Threads do not
> change what is being measured: they share one database connection and one lock, so database
> concurrency per process is still 1.

### 8.8 Database connections — there is no pool

`api/db.py` opens **one connection per worker process** and serialises access to it with a global
lock. Two consequences:

1. **Inside a worker, database concurrency is 1** — however many threads the server has. Scale with
   worker processes, not threads.
1a. **Write transactions must take the lock up front.** `db.transaction(immediate=True)` issues
   `BEGIN IMMEDIATE`. A deferred transaction upgrades from a read lock to a write lock on its first
   write, and SQLite deliberately does not apply `busy_timeout` to that upgrade — so under
   concurrent writers it fails instantly with "database is locked" and the caller sees a 500 on a
   payment they have already made. All three write paths (order placement, stock movements,
   erasure) use `immediate=True`; `bash db-contention-test.sh` guards it.
2. **Total connections held = workers x containers.** Size this against PostgreSQL's
   `max_connections` (minus `superuser_reserved_connections`) before scaling out. Exceeding it does
   not queue — see below.

> **Known defect — workers cannot boot without the database.** The connection is opened at module
> import, so a worker that cannot reach the database, or that PostgreSQL refuses because
> `max_connections` is exhausted, **dies during start-up**. It never reaches the health endpoint
> that exists to report exactly this condition, so `/api/health` does not answer at all rather than
> returning 503, and gunicorn crash-loops the workers until it exhausts its retry budget.
>
> Reproduce it with `bash db-contention-test.sh` (section 2).
>
> The fix is to open the connection lazily on first use and reconnect on failure, so a worker starts,
> serves 503 from `/api/health`, and recovers by itself when the database returns. Until then, treat
> a connection-budget overrun as a full outage rather than a degradation, and keep
> `workers x containers` comfortably under the PostgreSQL limit.

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| App refuses to start, complains about the secret key | `DJANGO_DEBUG=0` with the default `DJANGO_SECRET_KEY` | Set a real `DJANGO_SECRET_KEY` |
| `/api/health` returns 503 | The database is unreachable | Check `DATABASE_URL`, network rules, and that PostgreSQL is up |
| `/api/health` says `"database":"sqlite"` in production | `DATABASE_URL` is unset **or empty** | Set it to the PostgreSQL URL and redeploy |
| `/api/health` says `"paymentProvider"` is mock when you expect live | Provider keys unset or empty | Set the real Stripe/Razorpay keys |
| UI changes are not showing | `public/` was not rebuilt | `npm run build --prefix frontend`, commit the result, redeploy |
| Prescriptions come back as gibberish | `EPHARMA_ENC_KEY` differs from the one they were written with | Restore the original key, or set it as `EPHARMA_ENC_KEY_OLD` and rotate (§8.6) |
| "Assign a rider or courier before marking this order shipped" | Working as designed — the order has no carrier | Assign a rider or courier first (§5.7) |
| An order has no invoice number | It was placed before invoicing existed | Expected. Old orders are not retro-numbered, because inserting into a live serial series would break its consecutiveness |
| A stock level looks wrong | Someone typed it directly instead of booking a movement | Open the medicine's stock ledger — a direct edit is recorded as an `adjustment` with its author |
| Two workers, "database is locked" | SQLite under concurrent writes | Use PostgreSQL. SQLite is for demo and development only |
| Notifications are not arriving | `NOTIFY_CHANNELS` is `log` (the default) | Set the channels and implement the send call in `_deliver()` (`api/views.py`) |
| Test suite fails on a second PostgreSQL run | The database still holds data from the previous run | Drop and recreate the test database between runs |
| An admin asks to delete their own account | Admins cannot self-erase, by design | Delete the row directly after confirming another admin exists — see §5.11 |
| Startup logs are empty in a custom deployment | Python is buffering stdout | Set `PYTHONUNBUFFERED=1`. The provided Dockerfile already does |
| Clients get 429 during normal use | The window allowance is too low, or every request appears to come from the proxy | Raise `RATE_LIMIT`, or set `DJANGO_TRUST_PROXY=1` if a trusted proxy sets `X-Forwarded-For` (§8.7) |
| A load test reports thousands of failures | The harness measured through worker start-up, or rate limiting was left on | Wait for every worker to serve before measuring; set `RATE_LIMIT_ENABLED=0` when measuring capacity |
| Workers crash-loop and `/api/health` never answers | The database is unreachable or out of connection slots | See §8.8 — the connection is opened at import, so the worker dies before it can report. Free connections or restore the database, then restart |
| Adding threads did not increase throughput | Database access is serialised per process | Add worker processes instead (§8.8) |
| A load test reports `Can't assign requested address` | The load generator ran out of ephemeral ports, not a server error | Use keep-alive-capable workers (the harness does), widen the port range, or use fewer clients (§8.7) |
| 500 on checkout under concurrent load | A write transaction was deferred instead of immediate | Write paths must use `db.transaction(immediate=True)` — see §8.8 |

---

## 10. Recovery

### 10.1 Roll back a release

```bash
docker compose -f docker-compose.prod.yml down
# redeploy the previous image tag
bash smoketest.sh https://epharma.example.com
```

The database is untouched by a rollback: schema changes are **additive only** — the application adds
columns it needs on start-up and never drops, renames or rewrites anything. An older image running
against a newer database simply ignores the extra columns.

### 10.2 Restore the database

Restore the PostgreSQL dump, then confirm `EPHARMA_ENC_KEY` matches the key that was in use when the
dump was taken. Restoring data without its key leaves prescriptions, consultation messages and
verification documents permanently unreadable.

Verify after restoring:

```bash
bash smoketest.sh https://epharma.example.com
```

### 10.3 Upgrading an existing database

Nothing to run. On start-up the application creates missing tables, adds missing columns additively,
and leaves existing rows alone. Records that predate a feature degrade gracefully rather than
failing — an order placed before invoicing existed reports that no invoice was raised.

---

## 11. Reset and decommission

### 11.1 Reset a demo environment

```bash
rm -f epharma.db epharma.db-shm epharma.db-wal
```

Restart the application — the schema and demo seed are recreated from scratch.

### 11.2 Before serving real users

1. **Remove every demo account** (`admin@epharma.com`, `asha@epharma.com`, `rohan@epharma.com`,
   `kunal@epharma.com`, `store@medplus.com`, `store@healthkart.com`, `priya@gmail.com`) and the demo
   medicine catalog — or start from a database seeded only with your real admin account.
   **Their passwords are published in this repository.**
2. Work through the go-live checklist in §7.
3. Run `bash smoketest.sh` against the live URL and confirm every check passes.

### 11.3 Shutting down

```bash
docker compose -f docker-compose.prod.yml down
```

Before decommissioning permanently, take a final `pg_dump` **and** archive `EPHARMA_ENC_KEY` with it.
Medical and financial records carry statutory retention obligations that outlive the service — check
what applies before deleting anything.

---

## 12. Reference

**Environment variables** — the full table is in [deployment-runbook.md §3](deployment-runbook.md),
and the annotated template is `.env.example`.

**API** — the complete endpoint reference is in the [README](../README.md). The conventions:
`POST` creates, `PATCH` transitions state, and role scoping is always derived server-side from the
session token, never from a client-supplied id.

**Known limits and their upgrade paths** — [deployment-runbook.md §7](deployment-runbook.md).

**Open business decisions** — payment provider to license, SMS/email provider, whether to provision
managed Kafka. All are configuration switches; the code paths exist and are tested against mocks.
See [handover.md §7](handover.md).
