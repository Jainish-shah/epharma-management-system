"""Event streaming bus — Python port of events.js.

Services publish domain events to topics instead of calling each other directly, so producers
(orders, payments) are decoupled from consumers (notifications, receipts, delivery).

Default: an in-process bus (synchronous delivery) — zero config, the demo just runs. Set
KAFKA_BROKERS to stream through Apache Kafka; kafka-python is imported lazily only then.
"""
import json
import os

TOPICS = {"ORDERS": "orders", "PAYMENTS": "payments", "APPOINTMENTS": "appointments", "NOTIFICATIONS": "notifications"}

_handlers = {}
_BROKERS = os.environ.get("KAFKA_BROKERS")
_producer = None
_kafka_ready = False


def kafka_ready():
    """True when events are streaming through Kafka; False when using the in-process bus."""
    return _kafka_ready


def subscribe(topic, handler):
    _handlers.setdefault(topic, []).append(handler)


def _deliver_local(topic, payload):
    for h in _handlers.get(topic, []):
        h(payload)


def publish(topic, payload):
    """Fire-and-forget. No Kafka -> synchronous local delivery (keeps request-time behaviour)."""
    if _kafka_ready and _producer:
        try:
            _producer.send(topic, json.dumps(payload).encode())
            return
        except Exception as e:  # noqa: BLE001
            print(f"[kafka] publish failed, delivering in-process: {e}")
    _deliver_local(topic, payload)


def init_kafka():
    global _producer, _kafka_ready
    if not _BROKERS:
        print("[events] in-process event bus (set KAFKA_BROKERS to stream through Kafka)")
        return
    try:
        from kafka import KafkaProducer, KafkaConsumer  # lazy: only needed with Kafka
    except ImportError:
        print("[events] KAFKA_BROKERS set but kafka-python not installed — run `pip install kafka-python`. Using in-process bus.")
        return
    import threading
    brokers = _BROKERS.split(",")
    _producer = KafkaProducer(bootstrap_servers=brokers)
    consumer = KafkaConsumer(*TOPICS.values(), bootstrap_servers=brokers, group_id="epharma-services",
                             auto_offset_reset="latest")

    def _consume():
        for msg in consumer:
            try:
                _deliver_local(msg.topic, json.loads(msg.value.decode()))
            except Exception as e:  # noqa: BLE001
                print(f"[kafka] bad message on {msg.topic}: {e}")

    threading.Thread(target=_consume, daemon=True).start()
    _kafka_ready = True
    print(f"[events] Kafka connected ({_BROKERS}); topics: {', '.join(TOPICS.values())}")
