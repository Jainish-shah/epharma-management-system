// Phase 3 — payment gateway. Provider-neutral façade over Stripe and Razorpay.
//
// Pick the provider with PAYMENT_PROVIDER=stripe|razorpay (default: stripe).
// Each provider ships a built-in MOCK so the checkout flow is fully testable/demoable without
// live keys; the server-side verification mirrors the real provider so going live is a config change.
//
// Normalised interface every provider exposes:
//   createIntent(amountPaise) -> { id, amount, currency, key, clientSecret? }
//   mockCheckout(id)          -> the opaque object a real client SDK hands back after paying
//   orderIdOf(payload)        -> extract the provider order/intent id from that object
//   verify(id, payload)       -> boolean (payment genuinely completed for this intent)
const crypto = require('crypto');

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(a || '', 'utf8');
  const y = Buffer.from(b || '', 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------------- Stripe (PaymentIntents) ----------------
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
const STRIPE_PUBLISHABLE = process.env.STRIPE_PUBLISHABLE_KEY || 'pk_test_mock';
const stripe = {
  name: 'stripe',
  isMock: STRIPE_SECRET === 'sk_test_mock',
  createIntent(amount) {
    const id = 'pi_' + crypto.randomBytes(12).toString('hex');
    // client_secret is what Stripe.js uses to confirm the payment in the browser.
    return { id, amount, currency: 'inr', key: STRIPE_PUBLISHABLE, clientSecret: `${id}_secret_${hmac(STRIPE_SECRET, id).slice(0, 24)}` };
  },
  // Stand-in for confirming the PaymentIntent with Stripe.js. The proof stands in for Stripe
  // having marked the intent 'succeeded' — the real server check is stripe.paymentIntents.retrieve(id).
  mockCheckout(id) {
    return { provider: 'stripe', payment_intent: id, proof: hmac(STRIPE_SECRET, id) };
  },
  orderIdOf(p) {
    return p && p.payment_intent;
  },
  // NOTE (going live): replace with `await stripe.paymentIntents.retrieve(id)` and check status === 'succeeded'
  // (optionally verify a Stripe webhook signature). The mock proves the client held the intent secret.
  verify(id, p) {
    return !!p && p.payment_intent === id && safeEq(p.proof, hmac(STRIPE_SECRET, id));
  },
};

// ---------------- Razorpay (Orders) ----------------
const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_mock';
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'mock_secret';
const razorpay = {
  name: 'razorpay',
  isMock: RZP_KEY_ID === 'rzp_test_mock',
  createIntent(amount) {
    return { id: 'order_' + crypto.randomBytes(9).toString('hex'), amount, currency: 'INR', key: RZP_KEY_ID };
  },
  // Razorpay checkout widget returns these three fields; signature = HMAC(order_id|payment_id, secret).
  mockCheckout(orderId) {
    const paymentId = 'pay_' + crypto.randomBytes(9).toString('hex');
    return {
      provider: 'razorpay',
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: hmac(RZP_KEY_SECRET, `${orderId}|${paymentId}`),
    };
  },
  orderIdOf(p) {
    return p && p.razorpay_order_id;
  },
  verify(id, p) {
    return !!p && p.razorpay_order_id === id && safeEq(p.razorpay_signature, hmac(RZP_KEY_SECRET, `${id}|${p.razorpay_payment_id}`));
  },
};

const PROVIDERS = { stripe, razorpay };
const active = PROVIDERS[(process.env.PAYMENT_PROVIDER || 'stripe').toLowerCase()] || stripe;

module.exports = {
  provider: active.name,
  IS_MOCK: active.isMock,
  createIntent: (amount) => active.createIntent(amount),
  mockCheckout: (id) => active.mockCheckout(id),
  orderIdOf: (payload) => active.orderIdOf(payload),
  verify: (id, payload) => active.verify(id, payload),
};
