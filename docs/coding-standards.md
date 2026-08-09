# E-Pharma — Coding Standards

Conventions followed across the codebase. Kept short and enforced by review.

## General

- **Language/runtime:** Python ≥ 3.11, Django 5.2. No build step; the SPA is plain static files.
- **Formatting:** PEP 8, 4-space indent. Lines kept readable (~120 cols).
- **Naming:** `snake_case` for Python variables/functions, `SCREAMING_SNAKE` for constants, `snake_case` for DB columns and JSON API fields (consistent with the SQL schema). JSON keys that the frontend reads keep their original casing (e.g. `providerOrderId`, `demoCheckout`).
- **Comments:** explain *why*, not *what*. Non-obvious decisions and deliberate shortcuts are marked inline (e.g. the demo OTP return, the manual SQLite transaction).

## Backend (Django)

- **One responsibility per view.** Shared behaviour lives in helpers (`require_auth`, `notify`, `public_user`, validators). Plain Django views + `JsonResponse` (no ORM) so the SQL and JSON contract stay explicit.
- **Authentication & authorization:** every non-public view calls `require_auth(request, *roles)`. Ownership is re-checked in the query (`WHERE pharmacy_id = ?`), never trusted from the client.
- **Input validation at the boundary:** validate before touching the database. Use the shared helpers (`is_email`, `is_phone`, `non_empty`, `non_neg_num`). Return `400` with a clear, user-facing message.
- **Never leak secrets:** `password_hash` is stripped via `public_user` before any user object is returned.
- **Parameterised SQL only** — all values are bound with `?`/named params; no string concatenation of user input into SQL (SQL-injection safe).
- **Money & stock computed server-side.** Totals and stock decrements are derived from the database inside a transaction, never taken from the request.
- **Consistent errors:** handlers return `{ error: "message" }` with an appropriate status; unexpected failures fall through to the central error handler as JSON.

## Frontend (vanilla JS SPA)

- **Escape all user-supplied text** with `esc()` before inserting into HTML (XSS-safe rendering).
- **Single API helper** (`api()`) centralises auth headers and error handling; every call is wrapped in `try/catch` with a user-facing `toast`.
- **State is explicit:** session token/user in `localStorage`; view state in a few module-level variables. No hidden globals.

## Database

- Schema defined once in `api/db.py`; accessed via stdlib `sqlite3` with a thin helper layer (`query`, `get`, `run`, `transaction`).
- Parameterised SQL only — all values bound with `?`; no string concatenation of user input into SQL.
- Foreign keys declared and enforced (`PRAGMA foreign_keys = ON`).

## Testing

- Every feature has at least one assertion in the end-to-end suite (`bash test.sh`), including the failure/denial cases, run against a throwaway database.
- Tests must pass before a task is considered complete.

## Deliberate shortcuts (marked `NOTE:` in code)

Demo-scope simplifications are labelled in the source with a `NOTE:` comment naming the production upgrade path (e.g. OTP delivery, payment gateway). These are tracked, not forgotten.
