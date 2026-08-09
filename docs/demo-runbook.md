# E-Pharma — Demo Runbook (≈5 minutes)

**Before you start:** `npm start` → open http://localhost:3000. Fresh seed = 12 medicines,
3 doctors (2 approved), 2 pharmacies (1 approved), 1 patient, plus 2 pending registrations with documents.

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
- **Orders** tab → advance the order: *Start preparing* → *Mark shipped* → *Mark delivered*.
- **Inventory** tab → show add/edit/delete + low-stock warning.
- **Say:** "The pharmacy runs the fulfilment pipeline and manages its own stock." **Logout.**

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

## 7. Admin — oversight & document verification (Phase 2 highlight)  — 50 sec
- **Login** `admin@epharma.com` / `admin123`.
- **Overview** → live KPIs: users, orders, revenue, appointments, pending approvals.
- **Approvals** → **View documents** on a pending doctor/pharmacy → the uploaded degree/license/GSTIN proof shows → **Approve**.
- **Say:** "Admin verifies the uploaded documents before a doctor or pharmacy goes live, and monitors all orders and appointments."

---

## If asked "what's tested?"
`bash test.sh` → 45 automated end-to-end assertions across all roles, including OTP, validation and RBAC denials.

## Demo accounts
| Role | Email | Password |
|---|---|---|
| Admin | admin@epharma.com | admin123 |
| Doctor (approved) | asha@epharma.com | doctor123 |
| Pharmacy (approved) | store@medplus.com | pharma123 |
| Patient | priya@gmail.com | patient123 |

## Reset between runs
Stop the server, delete `epharma.db*`, `npm start` — back to a clean seed.
