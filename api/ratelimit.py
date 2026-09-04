"""Request rate limiting (429 Too Many Requests).

A fixed-window counter per client, per tier, held in process memory. Two tiers, because the two
kinds of abuse are different:

  * `auth`    — login, registration and OTP requests. Tight, because these are the endpoints an
                attacker brute-forces. A human logs in a handful of times a minute; a script does
                not.
  * `default` — every other /api/ route.

Only /api/ paths are limited. Static assets are excluded (one page load pulls several, and
throttling them would break the app for a legitimate user), and so is /api/health, because a
throttled health check makes a load balancer pull a healthy instance out of rotation.

ponytail: in-process counters, so with N gunicorn workers the effective limit is N x the configured
number — requests are spread across workers by the OS, not pinned to one. That is the right trade
for a single-instance deployment and it fails safe (too permissive, never wrongly locking a user
out). Move the counter to Redis when the limit has to be exact across workers or containers; the
only thing that changes is `_hit()`.
"""
import os
import threading
import time

from django.http import JsonResponse

# Requests allowed per window, per client. 0 disables that tier.
WINDOW = int(os.environ.get("RATE_LIMIT_WINDOW") or 60)          # seconds
LIMIT_DEFAULT = int(os.environ.get("RATE_LIMIT") or 120)         # per window, per client
LIMIT_AUTH = int(os.environ.get("RATE_LIMIT_AUTH") or 10)        # per window, per client
ENABLED = (os.environ.get("RATE_LIMIT_ENABLED") or "1").lower() not in ("0", "false", "no", "off")

# Trust X-Forwarded-For only when the app is explicitly told it sits behind a proxy. The header is
# attacker-controlled otherwise, and trusting it by default would let anyone forge a fresh identity
# per request and bypass the limit entirely.
TRUST_PROXY = (os.environ.get("DJANGO_TRUST_PROXY") or "0").lower() in ("1", "true", "yes", "on")

# Paths whose FIRST segment after /api/ puts them in the auth tier.
AUTH_PATHS = ("/api/login", "/api/register", "/api/me/delete")
EXEMPT_PATHS = ("/api/health",)

_MAX_KEYS = 20000            # hard cap on tracked clients, so the table cannot grow without bound
_buckets = {}                # key -> [window_start, count]
_lock = threading.Lock()


def client_ip(request):
    if TRUST_PROXY:
        fwd = request.META.get("HTTP_X_FORWARDED_FOR")
        if fwd:
            return fwd.split(",")[0].strip()   # left-most entry is the original client
    return request.META.get("REMOTE_ADDR") or "unknown"


def _hit(key, limit, now):
    """Count one request. Returns (allowed, remaining, seconds_until_reset)."""
    with _lock:
        if len(_buckets) > _MAX_KEYS:
            # Drop windows that have already expired. If that frees nothing (every client is
            # currently active) the table is cleared outright: losing counts fails open for one
            # window, which is far better than growing memory without limit.
            stale = [k for k, v in _buckets.items() if now - v[0] >= WINDOW]
            for k in stale:
                del _buckets[k]
            if len(_buckets) > _MAX_KEYS:
                _buckets.clear()

        bucket = _buckets.get(key)
        if bucket is None or now - bucket[0] >= WINDOW:
            bucket = [now, 0]
            _buckets[key] = bucket
        bucket[1] += 1
        reset = int(bucket[0] + WINDOW - now) + 1
        return bucket[1] <= limit, max(0, limit - bucket[1]), reset


def tier_for(path):
    """Which limit applies to this path, or None if the path is not rate limited."""
    if not path.startswith("/api/"):
        return None
    if path in EXEMPT_PATHS:
        return None
    if path.startswith(AUTH_PATHS):
        return "auth", LIMIT_AUTH
    return "default", LIMIT_DEFAULT


class RateLimitMiddleware:
    """Returns 429 with Retry-After once a client exceeds its window allowance."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        tier = tier_for(request.path) if ENABLED else None
        if not tier:
            return self.get_response(request)

        name, limit = tier
        if limit <= 0:                      # a tier set to 0 is switched off
            return self.get_response(request)

        now = time.time()
        allowed, remaining, reset = _hit(f"{name}:{client_ip(request)}", limit, now)
        if not allowed:
            response = JsonResponse(
                {"error": "Too many requests — please slow down and try again shortly"}, status=429)
            response["Retry-After"] = str(reset)
        else:
            response = self.get_response(request)

        # Standard rate-limit headers, so a client can back off before it is refused.
        response["RateLimit-Limit"] = str(limit)
        response["RateLimit-Remaining"] = str(remaining)
        response["RateLimit-Reset"] = str(reset)
        return response
