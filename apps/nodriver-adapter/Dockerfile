FROM python:3.12-slim

RUN addgroup --system --gid 10001 app && \
    adduser --system --uid 10001 --gid 10001 app

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-common \
    chromium-sandbox \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium
ENV XDG_CONFIG_HOME=/tmp
# Chromium needs a writable HOME and profile root for the non-root runtime user
# below; app/main.py passes CHROME_USER_DATA_DIR into uc.start() (one profile
# subdirectory per pooled browser).
ENV HOME=/tmp
ENV CHROME_USER_DATA_DIR=/tmp/chrome-user-data
RUN mkdir -p ${CHROME_USER_DATA_DIR} && chown -R 10001:10001 ${CHROME_USER_DATA_DIR}

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 3000
USER 10001

# SSRF filtering happens in app/main.py: every /scrape target URL is validated by
# assert_safe_target_url() (scheme allow-list + literal/resolved IP checks,
# IPv4-mapped IPv6 included) and rejected with HTTP 400 before it can reach
# browser.get() - only a validated SafeTarget can be navigated.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3000"]
