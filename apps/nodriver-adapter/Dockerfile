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
ENV CHROME_USER_DATA_DIR=/tmp/chrome-user-data

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 3000
USER 10001

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3000"]
