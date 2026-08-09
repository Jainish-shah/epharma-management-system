from django.apps import AppConfig


class ApiConfig(AppConfig):
    name = "api"

    def ready(self):
        # Seed the DB and register event consumers (importing views wires the subscribers).
        from . import db, events, views  # noqa: F401
        db.init_and_seed()
        events.init_kafka()
