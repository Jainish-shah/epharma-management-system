# E-Pharma — Coding Standards

Conventions followed across the codebase. Kept short and enforced by review.

## General

- **Language/runtime:** Python ≥ 3.11, Django 5.2. No build step; the SPA is plain static files.
- **Formatting:** PEP 8, 4-space indent. Lines kept readable (~120 cols).
- **Naming:** `snake_case` for Python variables/functions, `SCREAMING_SNAKE` for constants, `snake_case` for DB columns and JSON API fields (consistent with the SQL schema). JSON keys that the frontend reads keep their original casing (e.g. `providerOrderId`, `demoCheckout`).
- **Comments:** explain *why*, not *what*. Non-obvious decisions and deliberate shortcuts are marked inline (e.g. the demo OTP return, the manual SQLite transaction).

## Backend (Django)

- **One responsibility per view.** Shared behaviour lives in helpers (`notify`, `public_user`, validators). Plain Django views + `JsonResponse` (no ORM) so the SQL and JSON contract stay explicit.
- **Authentication & authorization is declarative:** every protected view is decorated `@auth(...roles)`, which enforces the rule and sets `request.user`. Public views use `@api`. Listings scope rows with `role_scope(user, {...})`. Ownership is re-checked in the query (`WHERE pharmacy_id = ?`), never trusted from the client.
- **Business rules live in exactly one function.** The cart rules (item exists, single pharmacy, stock available, price) are defined once in `price_cart()` and used by both checkout steps, so what priced the payment is what fills the order.
- **Input validation at the boundary:** validate before touching the database. Use the shared helpers (`is_email`, `is_phone`, `non_empty`, `non_neg_num`). Return `400` with a clear, user-facing message.
- **Never leak secrets:** `password_hash` is stripped via `public_user` before any user object is returned.
- **Parameterised SQL only** — all values are bound with `?`/named params; no string concatenation of user input into SQL (SQL-injection safe).
- **Money & stock computed server-side.** Totals and stock decrements are derived from the database inside a transaction, never taken from the request.
- **Consistent errors:** handlers return `{ error: "message" }` with an appropriate status; unexpected failures fall through to the central error handler as JSON.

## Frontend (React + Vite)

- **Function components and hooks only** — no classes. One component per screen or dialog; tab components live under `src/tabs/` grouped by role.
- **JSX escapes interpolated text automatically**, which is what keeps rendering XSS-safe. `dangerouslySetInnerHTML` is not used anywhere; keep it that way.
- **Single API helper** (`api()` in `src/api.js`) centralises the auth header, JSON handling and errors; every call is wrapped in `try/catch` with a user-facing `toast`.
- **State is explicit:** session token/user in `localStorage` (via `api.js`), everything else in `useState` close to where it is used. Toast and modal are the only global concerns, provided through one context (`useUI()`).
- **Data is fetched in `useEffect`** by the component that renders it, so each tab owns its own loading.
- **Accessibility is part of the component**, not an afterthought: label every input, give icon-only buttons an `aria-label`, and keep the dialog/tab ARIA roles when editing `ui.jsx` or the dashboard shell.
- **`public/` is generated** — never edit it by hand; change `frontend/src` and rebuild.

## Database

- Schema defined once in `api/db.py`; accessed via stdlib `sqlite3` with a thin helper layer (`query`, `get`, `run`, `transaction`).
- Parameterised SQL only — all values bound with `?`; no string concatenation of user input into SQL.
- Foreign keys declared and enforced (`PRAGMA foreign_keys = ON`).

## Testing

- Every feature has at least one assertion in the end-to-end suite (`bash test.sh`), including the failure/denial cases, run against a throwaway database.
- Tests must pass before a task is considered complete.

## Deliberate shortcuts (marked `NOTE:` in code)

Demo-scope simplifications are labelled in the source with a `NOTE:` comment naming the production upgrade path (e.g. OTP delivery, payment gateway). These are tracked, not forgotten.
