FROM node:18-slim

WORKDIR /usr/src

# Copy and build the shared ssrf-protection dependency first
COPY ssrf-protection/package*.json ./ssrf-protection/
COPY ssrf-protection/tsconfig.json ./ssrf-protection/
COPY ssrf-protection/src ./ssrf-protection/src
RUN cd ssrf-protection && npm install && npm run build

WORKDIR /usr/src/playwright-service-ts
COPY playwright-service-ts/package*.json ./
RUN npm install

COPY playwright-service-ts/ .

ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright

# Install Playwright dependencies
RUN npx playwright install chromium --with-deps

RUN npm run build

ARG PORT=3000
ENV PORT=${PORT}

EXPOSE ${PORT}

CMD [ "npm", "start" ]
