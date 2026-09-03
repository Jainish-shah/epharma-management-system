"""GST invoicing (Phase 8).

Every paid order becomes a tax invoice. Two rules drive the shape of this module:

  1. **Prices are GST-inclusive.** Indian retail medicine is sold at MRP, and MRP already contains
     the tax. So the invoice does not add tax on top of the order total — it *extracts* the tax
     from it. The customer pays exactly what the cart said; the invoice explains how much of that
     was tax. This is why `total` on the order never changes when an invoice is raised.

  2. **The invoice number is a legal serial, not a display string.** CGST Rule 46(b) requires a
     number that is consecutive *per supplier* and unique *within a financial year*. That rules out
     deriving it from the order id (whose sequence is global, so each pharmacy's series would have
     holes). Hence a counter row per pharmacy per FY — see `next_invoice_no`.
"""
from datetime import datetime, timezone

from . import db

SERIES = "INV"  # prefix of the invoice series, e.g. INV/2026-27/0007


def financial_year(when=None):
    """Indian financial year label for a date: 1 April 2026 – 31 March 2027 is '2026-27'."""
    d = when or datetime.now(timezone.utc)
    start = d.year if d.month >= 4 else d.year - 1
    return f"{start}-{str(start + 1)[-2:]}"


def next_invoice_no(pharmacy_id, when=None):
    """Reserve the next serial in this pharmacy's series for the current financial year.

    MUST be called inside a transaction (order placement already opens one). The UPDATE takes a
    row lock — on PostgreSQL that blocks a second concurrent checkout at the same pharmacy until
    this one commits, and on SQLite the write lock covers the whole transaction. Either way two
    orders can never be handed the same number.
    """
    fy = financial_year(when)
    db.run("INSERT INTO invoice_seq (pharmacy_id, fy, last_no) VALUES (?, ?, 0) ON CONFLICT DO NOTHING",
           (pharmacy_id, fy))
    db.run("UPDATE invoice_seq SET last_no = last_no + 1 WHERE pharmacy_id = ? AND fy = ?", (pharmacy_id, fy))
    seq = db.get("SELECT last_no FROM invoice_seq WHERE pharmacy_id = ? AND fy = ?", (pharmacy_id, fy))["last_no"]
    return f"{SERIES}/{fy}/{seq:04d}"


def split_tax(gross, rate):
    """Pull the tax out of a GST-inclusive amount.

    gross = taxable + tax, and tax = taxable * rate  =>  taxable = gross / (1 + rate).
    CGST and SGST are half each; sgst is taken as the remainder so the two halves always add back
    to the tax exactly, whatever the rounding did.
    """
    taxable = round(gross / (1 + rate / 100), 2)
    tax = round(gross - taxable, 2)
    cgst = round(tax / 2, 2)
    return {"taxable": taxable, "tax": tax, "cgst": cgst, "sgst": round(tax - cgst, 2)}


def build_invoice(order):
    """Assemble the full invoice document for an order (seller, buyer, lines, rate-wise summary).

    Returns None if the order has no invoice number, which only happens for orders placed before
    Phase 8 — they are shown without one rather than being retro-numbered, since inserting old
    invoices into a live serial series would break its consecutiveness.
    """
    if not order.get("invoice_no"):
        return None
    seller = db.get("SELECT name, store_name, address, gstin, license_no, phone FROM users WHERE id = ?",
                    (order["pharmacy_id"],))
    buyer = db.get("SELECT name, address, phone FROM users WHERE id = ?", (order["patient_id"],))
    # Read the rate stored on the line, never the medicine's current rate — an issued invoice is
    # a historical document and does not move when the catalogue is edited.
    items = db.query(
        "SELECT name, price, qty, COALESCE(gst_rate, 5) AS gst_rate FROM order_items WHERE order_id = ?",
        (order["id"],))

    lines, summary = [], {}
    for it in items:
        rate = float(it["gst_rate"])
        gross = round(float(it["price"]) * int(it["qty"]), 2)
        t = split_tax(gross, rate)
        lines.append({"name": it["name"], "qty": it["qty"], "rate": float(it["price"]),
                      "gst_rate": rate, "gross": gross, **t})
        # rate-wise totals — a GST invoice summarises tax per slab, not just one grand total
        acc = summary.setdefault(rate, {"gst_rate": rate, "taxable": 0, "cgst": 0, "sgst": 0})
        for k in ("taxable", "cgst", "sgst"):
            acc[k] = round(acc[k] + t[k], 2)

    return {
        "invoice_no": order["invoice_no"],
        "invoice_at": order["invoice_at"],
        "order_id": order["id"],
        # ponytail: intra-state supply assumed, so tax splits CGST + SGST. Inter-state orders would
        # charge a single IGST line instead — that needs a state code on both parties, which the
        # registration form does not collect yet.
        "place_of_supply": "Maharashtra (27)",
        "seller": {"name": seller["store_name"] or seller["name"], "address": seller["address"],
                   "gstin": seller["gstin"], "license_no": seller["license_no"], "phone": seller["phone"]},
        "buyer": {"name": buyer["name"], "address": order.get("address") or buyer["address"],
                  "phone": buyer["phone"]},
        "lines": lines,
        "tax_summary": sorted(summary.values(), key=lambda r: r["gst_rate"]),
        "taxable_total": round(sum(l["taxable"] for l in lines), 2),
        "cgst_total": round(sum(l["cgst"] for l in lines), 2),
        "sgst_total": round(sum(l["sgst"] for l in lines), 2),
        "tax_total": round(sum(l["tax"] for l in lines), 2),
        "grand_total": round(sum(l["gross"] for l in lines), 2),
    }
