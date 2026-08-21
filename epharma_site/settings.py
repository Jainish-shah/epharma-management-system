"""Django settings — token API + React SPA serving. No ORM, no sessions, no CSRF.

Development needs no configuration at all. For production set, at minimum:
    DJANGO_DEBUG=0
    DJANGO_SECRET_KEY=<a long random string>
    DJANGO_ALLOWED_HOSTS=epharma.example.com
See .env.example and docs/deployment-runbook.md.
"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _flag(name, default):
    """Read a boolean environment variable ('1'/'true'/'yes' are true)."""
    return (os.environ.get(name) or str(default)).lower() in ("1", "true", "yes", "on")


DEBUG = _flag("DJANGO_DEBUG", True)  # default True keeps local/demo runs zero-config

# A generated key is fine for local use; production MUST supply its own (the runbook explains why).
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY") or "dev-only-not-secret"
if not DEBUG and SECRET_KEY == "dev-only-not-secret":
    raise RuntimeError(
        "DJANGO_SECRET_KEY must be set when DJANGO_DEBUG=0. "
        "Generate one with: python -c \"import secrets; print(secrets.token_urlsafe(64))\""
    )

# In production, list the exact hostnames that serve the app.
ALLOWED_HOSTS = [h.strip() for h in (os.environ.get("DJANGO_ALLOWED_HOSTS") or "*").split(",") if h.strip()]

# 'api' provides the startup hook (AppConfig.ready) that seeds the DB and registers event consumers.
INSTALLED_APPS = ["api"]

# Auth is token-based in the views, so no session/CSRF middleware is needed. These two are what
# actually apply the security settings at the bottom of this file (headers, HTTPS redirect, HSTS) —
# without them those settings are silently inert.
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "epharma_site.urls"
WSGI_APPLICATION = "epharma_site.wsgi.application"
TEMPLATES = []

# We use stdlib sqlite3 / psycopg directly (api/db.py), not the Django ORM.
DATABASES = {}

DATA_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024  # base64 prescription/document uploads
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True

# ---------------- security (Phase 6) ----------------
# Sent on every response; harmless in development, meaningful behind HTTPS in production.
SECURE_CONTENT_TYPE_NOSNIFF = True          # don't let browsers guess content types
X_FRAME_OPTIONS = "DENY"                    # block clickjacking via <iframe>
SECURE_REFERRER_POLICY = "same-origin"      # don't leak URLs to third parties

if not DEBUG:
    # Trust the reverse proxy's X-Forwarded-Proto so Django knows the request arrived over HTTPS.
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    SECURE_SSL_REDIRECT = _flag("DJANGO_SSL_REDIRECT", True)   # off only if TLS terminates elsewhere
    SECURE_HSTS_SECONDS = int(os.environ.get("DJANGO_HSTS_SECONDS") or 31536000)  # 1 year
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
