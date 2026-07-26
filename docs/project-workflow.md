# E-Pharma Management System — Project Workflow

## Project Overview

An integrated ERP solution that connects medical stores, doctors, and patients on a single platform. It enables prescription-based ordering, teleconsultation, medicine delivery, stock management, and medical record handling with admin oversight.

## Module-Wise Workflow

### 1. Landing Page

- Welcome Message
- Login / Register (Patient | Doctor | Pharmacy | Admin)
- Search Bar (Medicine / Doctor)
- Quick Links: Book Appointment | Order Medicine

### 2. User Registration & Login

**A. Patient**
- Register with Mobile, Email, OTP
- Profile Setup (Health Conditions, Address)
- Upload Prescriptions (Optional)
- View Doctors / Order Medicines

**B. Doctor**
- Register with Qualification, Specialization
- Upload Documents (Degree, License)
- Admin Approval Required
- Set Availability Schedule

**C. Medical Store (Pharmacy)**
- Register with Store Details, License
- Upload Drug License & GSTIN
- Add Inventory (Stock, Price)
- Admin Approval Required

### 3. Patient Dashboard

- Search Medicines / Browse Categories
- Upload Prescription
- Place Order (Delivery / Pickup)
- Search Doctor by Specialty
- Book Online Consultation (Chat/Video)
- View Past Orders / Appointments
- Notifications & Reminders

### 4. Doctor Dashboard

- Manage Profile & Availability
- Accept / Reject Appointments
- Conduct Teleconsultations (Chat/Video)
- Generate & Upload e-Prescriptions
- View Patient History (If granted)
- Earnings & Reports

### 5. Pharmacy Dashboard

- Add / Update Medicines
- Track Orders (Pending, Shipped, Delivered)
- Upload GST Invoices
- Inventory Management (Stock In/Out)
- View Prescriptions Uploaded by Patients
- Delivery Assignment (Own or Partner)

### 6. Order Flow (Medicine Purchase)

```
Patient → Search/Add Medicine or Upload Prescription
        → Choose Pharmacy (based on location or price)
        → Add to Cart → Select Address → Make Payment
        → Pharmacy Prepares Order
        → Delivers to Patient / Marks Ready for Pickup
        → Admin monitors stock and delivery
```

### 7. Appointment Flow (Doctor Booking)

```
Patient → Choose Doctor → Select Slot
        → Confirm Booking → Get Reminders
        → Consultation (Chat/Video)
        → Doctor uploads Prescription
        → Patient receives it for download or medicine order
```

### 8. Admin Panel (ERP)

- User Management (Doctors / Patients / Pharmacies)
- Document Verification & Approval
- Prescription & Order Monitoring
- Appointment & Consultation Logs
- Manage Categories, Medicines, Specialties
- Reports (Revenue, Consultation, Orders)
- Notification & SMS Gateway
- CMS Management (FAQs, Terms, Privacy)
- Role & Permission Setup

### 9. Notifications & Alerts

- Booking Confirmations
- Prescription Upload Confirmations
- Medicine Order Status
- Refill Reminders
- Payment Receipts

## Data Privacy & Security

- Role-based Access Control (RBAC)
- Encrypted Prescriptions & Medical Records
- GDPR / HIPAA-aligned Policy Options
