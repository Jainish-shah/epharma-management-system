// Phase 3 — payment gateway (Razorpay-shaped).
//
// Ships with a built-in MOCK provider so the checkout flow is fully testable and demoable
// without live keys. To go live with real Razorpay: set RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET,
// and the client should load Razorpay's checkout.js (which returns the same three fields we verify
// below). The server-side signature verification is identical to production Razorpay.
const crypto = require('crypto');

const KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_mock';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'mock_secret';
const IS_MOCK = KEY_ID === 'rzp_test_mock';

// A real integration would call the Razorpay Orders API here; the mock mints a local id.
function createOrder(amountPaise) {
  return {
    id: 'order_' + crypto.randomBytes(9).toString('hex'),
    amount: amountPaise,
    currency: 'INR',
    key: KEY_ID,
  };
}

// Razorpay signature = HMAC_SHA256(`${order_id}|${payment_id}`, key_secret).
function sign(orderId, paymentId) {
  return crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}

function verify(orderId, paymentId, signature) {
  const expected = sign(orderId, paymentId);
  const got = Buffer.from(signature || '', 'utf8');
  const exp = Buffer.from(expected, 'utf8');
  return got.length === exp.length && crypto.timingSafeEqual(got, exp);
}

// Stand-in for the Razorpay checkout widget: produces the {order_id, payment_id, signature}
// triple the browser would normally receive after a successful card/UPI payment.
// Only exposed by the API when running on the mock provider.
function mockCheckout(orderId) {
  const paymentId = 'pay_' + crypto.randomBytes(9).toString('hex');
  return { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId) };
}

module.exports = { createOrder, verify, mockCheckout, KEY_ID, IS_MOCK };
