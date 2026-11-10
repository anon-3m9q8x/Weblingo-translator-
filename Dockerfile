FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py extractor.py limits.py security.py translation.py ./
COPY static ./static

RUN useradd --create-home --uid 10001 weblingo
USER weblingo

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/healthz', timeout=4)"

# 1 worker: rate limits / daily budgets are kept in process memory.
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*' --workers 1"]
