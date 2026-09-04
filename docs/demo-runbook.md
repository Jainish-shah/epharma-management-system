# E-Pharma — Demo Runbook (≈5 minutes)

**Before you start:** `.venv/bin/python manage.py runserver 127.0.0.1:3000 --noreload` → open
http://localhost:3000. Fresh seed = 12 medicines, 3 doctors (2 approved), 2 pharmacies (1 approved),
1 patient, plus 2 pending registrations with documents.

> Tip: keep this open on a second screen. Each step lists **what to click** and **what to say**.

---

## 0. Landing page (logged out)  — 20 sec
- **Show:** the landing page. Search "para" → medicines + doctors filter live.
- **Say:** "One platform connecting patients, doctors and pharmacies. Anyone can browse medicines and doctors before signing in."

## 1. Patient — OTP registration (Phase 2 highlight)  — 40 sec
- **Click** Register → role **Patient**. Fill name/email/mobile/password/address.
- **Click** *Send OTP* → the demo code appears under the field.
- Enter the code → **Register**.
- **Say:** "Patient sign-up is secured with OTP verification of email/mobile. In production this code is delivered by SMS/email; in the demo it's shown on screen."

## 2. Patient — order medicine  — 60 sec
- On the Medicines tab, **Add to cart** two items (e.g. Paracetamol, Cetirizine).
- **Click** the floating **Cart** button → choose Home delivery → (optionally attach a prescription image) → **Pay (demo)**.
- Go to **My Orders** → order shows status **pending**.
- **Say:** "Stock is checked and the total is calculated on the server, inside a transaction — the client never sets the price. An order can't exceed available stock."

## 3. Patient — book a doctor  — 30 sec
- **Doctors** tab → **Book** on Dr. Asha Mehta → pick a date + slot → **Confirm**.
- **Say:** "Patients book consultation slots from each doctor's availability."
- **Logout.**

## 4. Pharmacy — fulfil the order  — 40 sec
- **Login** `store@medplus.com` / `pharma123`.
- **Bell** (top right) shows the new-order notification.
- **Orders** tab → *Start preparing*. Now try *Mark shipped* — it is refused.
- **Assign delivery** → own rider or partner courier → then *Mark shipped* → *Mark delivered*.
- **Say:** "Nothing leaves the store unattributed — an order cannot be marked shipped until a rider or courier is on it, and the patient is told who has their order."
- **Inventory** tab → GST slab per medicine, low-stock warning, and **Stock** → the movement ledger: every change with its reason, balance and author.
- **Say:** "The pharmacy runs the fulfilment pipeline, and every unit of stock traces back to a movement." **Logout.**

## 5. Doctor — consult & e-prescribe  — 40 sec
- **Login** `asha@epharma.com` / `doctor123`.
- **Appointments** → **Accept** the request → **Write e-prescription** → type an Rx → upload.
- **Earnings** tab → completed consultation + total.
- **Say:** "Confirming and prescribing completes the consultation; the prescription lands in the patient's records and earnings update." **Logout.**

## 6. Patient — closed loop  — 20 sec
- **Login** `priya@gmail.com` / `patient123` (or the account you just made if you ordered on it).
- **Bell** → notifications for order status + prescription. **Prescriptions** tab → view the e-prescription.
- **Say:** "The patient is notified at every step and can view or download the prescription."
- **Logout.**

## 6b. Patient — the tax invoice (Phase 8 highlight)  — 30 sec
- **My Orders** → click the invoice number (e.g. `INV/2026-27/0001`).
- **Say:** "Every paid order raises a GST tax invoice on that pharmacy's own serial series, consecutive and reset each financial year. Medicine is sold at MRP, which already contains the tax, so the invoice extracts the CGST and SGST rather than adding them — the total is exactly what was paid. It prints to PDF from the browser."

## 6c. Any role — Privacy (Phase 7 highlight)  — 30 sec
- **Privacy** tab → the consent record, **Download my data**, **Delete my account**.
- **Say:** "Every user can see what policy they accepted, export everything held about them, and ask to be erased. Erasure removes the person but keeps orders and prescriptions de-identified, because a pharmacy is required to retain them."

## 7. Admin — oversight & document verification (Phase 2 highlight)  — 50 sec
- **Login** `admin@epharma.com` / `admin123`.
- **Overview** → live KPIs: users, orders, revenue, appointments, pending approvals.
- **Approvals** → **View documents** on a pending doctor/pharmacy → the uploaded degree/license/GSTIN proof shows → **Approve**.
- **Retention** → the policy and the purge.
- **Say:** "Admin verifies the uploaded documents before a doctor or pharmacy goes live, monitors all orders and appointments, and runs the data-retention policy."

---

## If asked "what's tested?"
`bash test.sh` → 85 automated end-to-end assertions across all roles, including OTP, validation,
RBAC denials, payment verification, GST invoicing, the stock ledger, consent and erasure. Passes on
both SQLite and PostgreSQL.

## Demo accounts
| Role | Email | Password |
|---|---|---|
| Admin | admin@epharma.com | admin123 |
| Doctor (approved) | asha@epharma.com | doctor123 |
| Pharmacy (approved) | store@medplus.com | pharma123 |
| Patient | priya@gmail.com | patient123 |

## Reset between runs
Stop the server, `rm -f epharma.db epharma.db-shm epharma.db-wal`, start it again — clean seed.
