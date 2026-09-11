from django.apps import AppConfig


class ApiConfig(AppConfig):
    name = "api"

    def ready(self):
        # Seed the DB and register event consumers (importing views wires the subscribers).
        from . import db, events, views  # noqa: F401
        try:
            db.init_and_seed()
        except Exception as e:  # noqa: BLE001
            # Never let an unreachable database stop the worker from starting. A worker that dies
            # here cannot serve /api/health, so the outage cannot even be reported to the load
            # balancer. It starts, answers 503, and initialises once the database is reachable.
            print(f"[db] database unreachable at start-up ({e}); will initialise on first contact")
            db.defer_init()
        events.init_kafka()
