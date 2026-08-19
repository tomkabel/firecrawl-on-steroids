FROM node:22-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true

RUN corepack enable && corepack prepare pnpm@11.4.0 --activate

WORKDIR /usr/src/app

# Build the shared ssrf-protection dependency first (required by playwright-service)
COPY ssrf-protection/package*.json ./ssrf-protection/
COPY ssrf-protection/tsconfig.json ./ssrf-protection/
COPY ssrf-protection/src ./ssrf-protection/src
WORKDIR /usr/src/app/ssrf-protection
RUN npm install && npm run build

WORKDIR /usr/src/app/playwright-service-ts
COPY playwright-service-ts/package*.json ./playwright-service-ts/pnpm-lock.yaml ./playwright-service-ts/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY playwright-service-ts/ .

ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright

# Install Playwright dependencies
RUN pnpm exec playwright install chromium --with-deps

RUN pnpm run build

RUN chown -R node:node /usr/src/app \
  && chmod -R a+rX /usr/local/share/playwright

ARG PORT=3000
ENV PORT=${PORT}

EXPOSE ${PORT}

USER node

CMD [ "pnpm", "start" ]
