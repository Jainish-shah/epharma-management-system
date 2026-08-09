"""Minimal Django settings — token API + SPA serving. No ORM, no sessions, no CSRF."""
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = "dev-only-not-secret"
DEBUG = True
ALLOWED_HOSTS = ["*"]

# 'api' provides the startup hook (AppConfig.ready) that seeds the DB and registers event consumers.
INSTALLED_APPS = ["api"]
MIDDLEWARE = []  # token auth in views; no sessions/CSRF needed

ROOT_URLCONF = "epharma_site.urls"
WSGI_APPLICATION = "epharma_site.wsgi.application"
TEMPLATES = []

# We use stdlib sqlite3 directly (api/db.py), not the Django ORM.
DATABASES = {}

DATA_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024  # base64 prescription/document uploads
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True
