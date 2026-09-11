# E-Pharma — Deployment Runbook

Operational guide for deploying and running the E-Pharma Management System in production.
Written for whoever operates the service after handover.

---

## 1. What gets deployed

One container image containing:

- the **Django** application (REST API), served by **gunicorn**;
- the **React** frontend, pre-built into `public/` and served by the same process.

One process, one port. TLS and load balancing terminate in front of it. PostgreSQL runs separately.

```
        HTTPS
Internet ──▶ Load balancer / reverse proxy ──▶ gunicorn (Django + React) ──▶ PostgreSQL
             (TLS, X-Forwarded-Proto)            :8000                        :5432
```

---

## 2. Prerequisites

| Requirement | Notes |
|---|---|
| Docker + Docker Compose | Or any container host (ECS, Cloud Run, Kubernetes, Render…) |
| PostgreSQL 14+ | Managed instance recommended. **Required in production** — see §7 |
| TLS certificate | Terminated at the load balancer / proxy |
| Hostname | Must be listed in `DJANGO_ALLOWED_HOSTS` |

If deploying without Docker, Python 3.11+ and `pip install -r requirements.txt` are enough — no
Node toolchain is needed, because the frontend build is committed.

---

## 3. Configuration

Copy `.env.example` to `.env` and fill it in. **Never commit `.env`** (it is git-ignored).

Generate the two secrets:

```bash
python -c "import secrets; print(secrets.token_urlsafe(64))"   # DJANGO_SECRET_KEY
python -c "import secrets; print(secrets.token_urlsafe(48))"   # EPHARMA_ENC_KEY
```

| Variable | Required | Purpose |
|---|---|---|
| `DJANGO_DEBUG` | yes | Must be `0` in production. The app refuses to start with the default secret key when debug is off |
| `DJANGO_SECRET_KEY` | yes | Django cryptographic signing |
| `DJANGO_ALLOWED_HOSTS` | yes | Comma-separated hostnames. Do not use `*` in production |
| `EPHARMA_ENC_KEY` | yes | Encrypts prescriptions, consultation messages and documents at rest |
| `DATABASE_URL` | yes | `postgresql://user:pass@host:5432/db`. Unset falls back to SQLite (demo only) |
| `DJANGO_SSL_REDIRECT` | no | `0` when the proxy terminates TLS (usual). `1` makes the app redirect HTTP→HTTPS |
| `WEB_CONCURRENCY` | no | gunicorn worker processes per container (default `3`). Each holds one database connection |
| `PAYMENT_PROVIDER` | no | `stripe` (default) or `razorpay` |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` | no | Live Stripe keys. Leave **unset** to keep the sandbox gateway |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | no | Live Razorpay keys |
| `KAFKA_BROKERS` | no | e.g. `broker:9092`. Unset uses the in-process event bus — see §7 |
| `NOTIFY_CHANNELS` | no | `log`, `email`, `sms` (comma-separated) |
| `RATE_LIMIT` / `RATE_LIMIT_AUTH` | no | Requests per window per client: general tier / auth tier. Defaults `120` / `10` |
| `RATE_LIMIT_WINDOW` | no | Window in seconds (default `60`) |
| `RATE_LIMIT_ENABLED` | no | `0` disables rate limiting — for load testing, not production |
| `DJANGO_TRUST_PROXY` | no | `1` to take the client IP from `X-Forwarded-For`. **Set this behind a load balancer**, or every request shares one bucket. Never set it without a trusted proxy in front |

> **Compose passes only what it lists.** A variable set in `.env` reaches the container only if it
> appears under `environment:` in `docker-compose.prod.yml`; anything else is silently ignored.
> `bash deploy-verify.sh` checks that every setting in `.env.example` is passed through.

> **Empty is not unset.** An empty value (`STRIPE_SECRET_KEY=`) is treated as unset and falls back to
> the default. This matters because Compose passes unset variables through as empty strings.

---

## 4. Deploy

```bash
cp .env.example .env          # then edit it
docker compose -f docker-compose.prod.yml up -d --build
```

Then verify — always, on every release:

```bash
bash smoketest.sh https://epharma.example.com
```

It checks health, the SPA, the public API, that authentication is enforced, and that the security
headers are present. It is read-only and safe against production. A non-zero exit means **roll back**.

### Rollback

```bash
docker compose -f docker-compose.prod.yml down
# redeploy the previous image tag, then re-run the smoke test
```

The database is untouched by a rollback: the app never drops or alters existing tables.

---

## 5. Operating

**Health check** — point the load balancer at `GET /api/health`. It returns `200` only when the
database answers, `503` otherwise, and reports which database, payment provider and event bus are live:

```json
{"status":"ok","database":"postgresql","paymentProvider":"stripe","events":"in-process"}
```

**Logs** — the app logs to stdout/stderr (`docker compose logs -f web`). Payment, order and
notification-delivery events each log a line, so a failed delivery is visible.

**Scaling** — increase gunicorn workers with the `WEB_CONCURRENCY` env var (default `3`) or run more
containers behind the load balancer. Roughly `2 × CPU cores + 1` workers per container.

**Backups** — back up PostgreSQL (`pg_dump`) on your provider's schedule. **Also back up
`EPHARMA_ENC_KEY` separately**: a database backup is unreadable without it.

**Audit trail** — logins (including failures), approvals, orders and prescriptions are recorded and
reviewable by an admin at `GET /api/admin/audit`.

---

## 6. First-run behaviour

On an empty database the app creates its schema and seeds demo data (demo users, a medicine catalog,
CMS pages). An existing database is never re-seeded or modified.

> **Before going live with real users, remove the demo accounts** (the four accounts listed in the
> README), or start from a database seeded only with your real admin account. The demo passwords are
> published in this repository.

Seeding is safe with multiple workers booting at once — it is serialised with an advisory lock on
PostgreSQL, and a write-locked transaction on SQLite.

---

## 7. Known limits and their upgrade paths

| Limit | Impact | Upgrade path |
|---|---|---|
| **SQLite** with multiple workers | Write contention; not suitable for production traffic | Set `DATABASE_URL` to PostgreSQL — supported and tested |
| **In-process event bus** across containers | An event published in one container is only consumed there. Fine for the current consumers (each persists/delivers locally), but it does not fan out across replicas | Set `KAFKA_BROKERS` — the code path already exists |
| **Payments run on a mock gateway** unless keys are set | No real money moves | Set the Stripe or Razorpay keys; verification logic is unchanged |
| **Notifications log instead of sending** | No real email/SMS | Set `NOTIFY_CHANNELS` and implement the send call in `_deliver()` (`api/views.py`) |
| **Video uses public `meet.jit.si`** | Rooms are unguessable but hosted by a third party | Self-host Jitsi, or move to a provider with signed room tokens |
| **Refill reminders are evaluated on request** | A reminder appears when the patient next loads notifications, not at a fixed time | Move `run_due_refills()` into a scheduled job |

---

## 8. Security checklist before go-live

- [ ] `DJANGO_DEBUG=0` and a unique `DJANGO_SECRET_KEY` are set
- [ ] `DJANGO_ALLOWED_HOSTS` lists the real hostnames (no `*`)
- [ ] TLS is enforced end to end; `smoketest.sh` reports the HSTS header on the HTTPS URL
- [ ] `EPHARMA_ENC_KEY` is set, stored in a secrets manager, and backed up
- [ ] `DATABASE_URL` points at PostgreSQL, and the database is not publicly reachable
- [ ] Demo accounts removed (§6)
- [ ] Database backups scheduled and a restore has been tested
- [ ] Retention purge scheduled as a nightly job (`POST /api/admin/retention/purge`)
- [ ] `EPHARMA_ENC_KEY_OLD` is **not** set once a key rotation has finished

For the full lifecycle — running, verifying, the business flow, operating, troubleshooting and
recovery — see the [operations runbook](runbook.md).
