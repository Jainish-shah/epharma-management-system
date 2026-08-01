// Phase 3 — event streaming bus.
//
// Services publish domain events to topics instead of calling each other directly, so producers
// (orders, payments) are decoupled from consumers (notifications, receipts, analytics).
//
// Default: an in-process bus (Node EventEmitter) — zero config, delivery is synchronous, the demo
// just runs. Set KAFKA_BROKERS (e.g. "localhost:9092") to stream through Apache Kafka instead:
// publishes go to Kafka and a single consumer group re-delivers them to the local subscribers, so
// each event is processed once and the app scales to multiple instances. kafkajs is loaded lazily
// only when KAFKA_BROKERS is set — see docker-compose.yml for a local broker.
const { EventEmitter } = require('events');

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

const TOPICS = {
  ORDERS: 'orders',
  PAYMENTS: 'payments',
  APPOINTMENTS: 'appointments',
  NOTIFICATIONS: 'notifications',
};

const BROKERS = process.env.KAFKA_BROKERS;
let producer = null;
let kafkaReady = false;

const subscribe = (topic, handler) => emitter.on(topic, handler);
const deliverLocal = (topic, payload) => emitter.emit(topic, payload);

// Fire-and-forget publish. With no Kafka this delivers synchronously (there is no await before
// deliverLocal), which keeps the request-time behaviour the app already relied on. With Kafka it
// hands off to the broker and the consumer re-delivers locally.
async function publish(topic, payload) {
  if (kafkaReady && producer) {
    try {
      await producer.send({ topic, messages: [{ value: JSON.stringify(payload) }] });
      return;
    } catch (e) {
      console.error('[kafka] publish failed, delivering in-process:', e.message);
    }
  }
  deliverLocal(topic, payload);
}

// Connect to Kafka if configured; safe to call always (no-op without KAFKA_BROKERS).
async function initKafka() {
  if (!BROKERS) {
    console.log('[events] in-process event bus (set KAFKA_BROKERS to stream through Kafka)');
    return;
  }
  let Kafka;
  try {
    ({ Kafka } = require('kafkajs'));
  } catch {
    console.error('[events] KAFKA_BROKERS set but kafkajs is not installed — run `npm i kafkajs`. Using in-process bus.');
    return;
  }
  const kafka = new Kafka({ clientId: 'epharma', brokers: BROKERS.split(',') });
  producer = kafka.producer();
  await producer.connect();
  const consumer = kafka.consumer({ groupId: 'epharma-services' });
  await consumer.connect();
  for (const t of Object.values(TOPICS)) await consumer.subscribe({ topic: t, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      try { deliverLocal(topic, JSON.parse(message.value.toString())); }
      catch (e) { console.error('[kafka] bad message on', topic, e.message); }
    },
  });
  kafkaReady = true;
  console.log(`[events] Kafka connected (${BROKERS}); topics: ${Object.values(TOPICS).join(', ')}`);
}

module.exports = { TOPICS, publish, subscribe, initKafka, get kafkaReady() { return kafkaReady; } };
