# Production image for the E-Pharma backend + built React frontend.
#
# The React app is pre-built into public/ and committed, so this image needs Python only —
# no Node toolchain in the runtime image. Rebuild the frontend before building this image if the
# UI changed:  npm run build --prefix frontend
FROM python:3.12-slim

# Don't buffer stdout (so logs appear immediately) and don't write .pyc files.
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Install dependencies first so this layer is cached when only application code changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Run as a non-root user.
RUN useradd --create-home --uid 1000 epharma \
    && mkdir -p /app/data && chown -R epharma:epharma /app
USER epharma

# SQLite (when no DATABASE_URL is set) lives on a volume so data survives container restarts.
ENV EPHARMA_DB=/app/data/epharma.db
VOLUME ["/app/data"]

EXPOSE 8000

# Container health check — the same endpoint a load balancer should probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health').status==200 else 1)"

# 3 workers is a sane default for a small instance; tune with the WEB_CONCURRENCY env var.
CMD ["gunicorn", "epharma_site.wsgi:application", \
     "--bind", "0.0.0.0:8000", "--workers", "3", \
     "--access-logfile", "-", "--error-logfile", "-"]
