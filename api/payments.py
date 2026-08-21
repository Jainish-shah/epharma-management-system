"""Payment gateway — Python port of payments.js. Provider-neutral facade over Stripe and Razorpay.

Pick the provider with PAYMENT_PROVIDER=stripe|razorpay (default: stripe). Each provider ships a
built-in MOCK so the checkout flow is fully testable without live keys; server-side verification
mirrors the real provider so going live is a config change.
"""
import hashlib
import hmac
import os
import secrets


def _hmac(secret, data):
    return hmac.new(secret.encode(), data.encode(), hashlib.sha256).hexdigest()


def _safe_eq(a, b):
    return hmac.compare_digest((a or "").encode(), (b or "").encode())


# ---------------- Stripe (PaymentIntents) ----------------
_STRIPE_SECRET = os.environ.get("STRIPE_SECRET_KEY") or "sk_test_mock"
_STRIPE_PUB = os.environ.get("STRIPE_PUBLISHABLE_KEY") or "pk_test_mock"


class _Stripe:
    name = "stripe"
    is_mock = _STRIPE_SECRET == "sk_test_mock"

    def create_intent(self, amount):
        pid = "pi_" + secrets.token_hex(12)
        return {"id": pid, "amount": amount, "currency": "inr", "key": _STRIPE_PUB,
                "clientSecret": f"{pid}_secret_{_hmac(_STRIPE_SECRET, pid)[:24]}"}

    def mock_checkout(self, pid):
        return {"provider": "stripe", "payment_intent": pid, "proof": _hmac(_STRIPE_SECRET, pid)}

    def order_id_of(self, p):
        return p.get("payment_intent") if p else None

    # NOTE (live): replace with stripe.PaymentIntent.retrieve(id) and check status == 'succeeded'.
    def verify(self, pid, p):
        return bool(p) and p.get("payment_intent") == pid and _safe_eq(p.get("proof"), _hmac(_STRIPE_SECRET, pid))


# ---------------- Razorpay (Orders) ----------------
_RZP_KEY_ID = os.environ.get("RAZORPAY_KEY_ID") or "rzp_test_mock"
_RZP_KEY_SECRET = os.environ.get("RAZORPAY_KEY_SECRET") or "mock_secret"


class _Razorpay:
    name = "razorpay"
    is_mock = _RZP_KEY_ID == "rzp_test_mock"

    def create_intent(self, amount):
        return {"id": "order_" + secrets.token_hex(9), "amount": amount, "currency": "INR", "key": _RZP_KEY_ID,
                "clientSecret": None}

    def mock_checkout(self, order_id):
        payment_id = "pay_" + secrets.token_hex(9)
        return {"provider": "razorpay", "razorpay_order_id": order_id, "razorpay_payment_id": payment_id,
                "razorpay_signature": _hmac(_RZP_KEY_SECRET, f"{order_id}|{payment_id}")}

    def order_id_of(self, p):
        return p.get("razorpay_order_id") if p else None

    def verify(self, order_id, p):
        return (bool(p) and p.get("razorpay_order_id") == order_id
                and _safe_eq(p.get("razorpay_signature"), _hmac(_RZP_KEY_SECRET, f"{order_id}|{p.get('razorpay_payment_id')}")))


_PROVIDERS = {"stripe": _Stripe(), "razorpay": _Razorpay()}
_active = _PROVIDERS.get((os.environ.get("PAYMENT_PROVIDER") or "stripe").lower(), _PROVIDERS["stripe"])

provider = _active.name
IS_MOCK = _active.is_mock
create_intent = _active.create_intent
mock_checkout = _active.mock_checkout
order_id_of = _active.order_id_of
verify = _active.verify
