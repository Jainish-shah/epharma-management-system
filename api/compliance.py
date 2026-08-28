"""Phase 7 — data governance: retention, subject access, and erasure.

The rules a data-protection reviewer would ask about live here, in one file, rather than being
spread through the endpoints:

  * how long each kind of record is kept          -> RETENTION_DAYS / purge_expired()
  * what "give me my data" returns                -> export_user_data()
  * what "delete my account" actually does        -> erase_user()

The erasure rule is the one real judgement call. Prescriptions, orders and payments are medical and
financial records that a pharmacy is normally required to retain, so they are NOT deleted. Instead
the person behind them is erased: every field that identifies the user is overwritten and the login
is disabled, leaving records that can still be audited but can no longer be traced back to an
individual. This is pseudonymisation, and it is the usual way the right to erasure and a statutory
retention duty are reconciled. Where the law of the deployment demands hard deletion instead,
change it here — that is why it is one function.
"""
import os
from datetime import datetime, timedelta, timezone

from . import crypto, db

# Current privacy-policy version. Bump this when the policy text changes materially; users whose
# recorded consent is older can then be asked to accept the new version.
POLICY_VERSION = os.environ.get("POLICY_VERSION") or "1.0"

# How long each kind of record is kept. Values are days; override per deployment.
RETENTION_DAYS = {
    # One-time codes are single-use and short-lived; anything left is abandoned.
    "otps": float(os.environ.get("RETAIN_OTPS_DAYS") or 1),
    # Idle sessions: a token older than this is treated as expired and removed.
    "tokens": float(os.environ.get("RETAIN_TOKENS_DAYS") or 30),
    # Read notifications are a convenience feature, not a record.
    "notifications": float(os.environ.get("RETAIN_NOTIFICATIONS_DAYS") or 180),
    # The audit trail is a security record and is kept substantially longer.
    "audit_log": float(os.environ.get("RETAIN_AUDIT_DAYS") or 365),
}


def _cutoff(days):
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")


def purge_expired():
    """Delete records that have passed their retention window. Returns {table: rows_removed}.

    Safe to run repeatedly (it only ever removes rows already past their window), so it suits a
    nightly scheduled job as well as the admin-triggered endpoint.
    """
    removed = {}
    for table, days in RETENTION_DAYS.items():
        cutoff = _cutoff(days)
        # created_at may be NULL on rows written before that column existed; treat those as current
        # rather than deleting data we cannot date.
        where = "created_at IS NOT NULL AND created_at < ?"
        if table == "notifications":
            where += " AND read = 1"  # never silently drop something the user has not seen
        before = db.get(f"SELECT COUNT(*) AS c FROM {table}")["c"]
        db.run(f"DELETE FROM {table} WHERE {where}", (cutoff,))
        after = db.get(f"SELECT COUNT(*) AS c FROM {table}")["c"]
        removed[table] = before - after
    return removed


def export_user_data(user):
    """Everything held about this person, decrypted, as plain JSON-ready data (right of access and
    data portability). Only the caller's own records are included."""
    uid = user["id"]
    out = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "account": db.public_user(user),
        "orders": [],
        "appointments": [],
        "prescriptions": [],
        "consultation_messages": [],
        "notifications": db.query("SELECT * FROM notifications WHERE user_id = ? ORDER BY id", (uid,)),
        "refill_reminders": db.query("SELECT * FROM refill_reminders WHERE patient_id = ? ORDER BY id", (uid,)),
    }

    orders = db.query("SELECT * FROM orders WHERE patient_id = ? ORDER BY id", (uid,))
    for o in orders:
        o["items"] = db.query("SELECT * FROM order_items WHERE order_id = ?", (o["id"],))
    out["orders"] = orders

    out["appointments"] = db.query(
        "SELECT * FROM appointments WHERE patient_id = ? OR doctor_id = ? ORDER BY id", (uid, uid))

    rxs = db.query("SELECT * FROM prescriptions WHERE patient_id = ? OR doctor_id = ? ORDER BY id", (uid, uid))
    for r in rxs:
        r["content"] = crypto.decrypt(r["content"])  # the person is entitled to readable content
    out["prescriptions"] = rxs

    msgs = db.query("SELECT * FROM messages WHERE sender_id = ? ORDER BY id", (uid,))
    for m in msgs:
        m["body"] = crypto.decrypt(m["body"])
    out["consultation_messages"] = msgs

    if user.get("documents"):
        out["account"]["documents"] = crypto.decrypt(user["documents"])
    return out


def erase_user(user):
    """Right to erasure. Overwrites every identifying field, disables the login and ends all
    sessions, while leaving medical/financial records in place for their retention period (see the
    module docstring). Returns a short summary of what was done."""
    uid = user["id"]
    placeholder = f"erased-user-{uid}"
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    with db.transaction():
        db.run(
            "UPDATE users SET name = ?, email = ?, phone = NULL, address = NULL, documents = NULL, "
            "store_name = NULL, license_no = NULL, gstin = NULL, qualification = NULL, "
            "availability = NULL, password_hash = ?, anonymised_at = ? WHERE id = ?",
            ("Erased user", f"{placeholder}@invalid", os.urandom(32).hex(), now, uid),
        )
        # End every session immediately, and drop personal notifications (they quote names/addresses).
        db.run("DELETE FROM tokens WHERE user_id = ?", (uid,))
        db.run("DELETE FROM notifications WHERE user_id = ?", (uid,))
        db.run("DELETE FROM refill_reminders WHERE patient_id = ?", (uid,))

    return {
        "erased": True,
        "account": "personal details overwritten and login disabled",
        "retained": "orders, payments and prescriptions kept in de-identified form for the "
                    "statutory retention period",
    }
