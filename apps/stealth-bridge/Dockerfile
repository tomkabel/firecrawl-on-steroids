FROM node:22-slim AS builder

WORKDIR /build

COPY package.json tsconfig.json ./
RUN npm install

COPY src/ src/
RUN npm run build && npm prune --omit=dev

FROM node:22-slim

RUN addgroup --system --gid 10001 app && adduser --system --uid 10001 --gid 10001 app

WORKDIR /app

COPY --from=builder --chown=app:app /build/dist ./dist
COPY --from=builder --chown=app:app /build/node_modules ./node_modules
COPY --from=builder --chown=app:app /build/package.json ./

USER app

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=10s \
    CMD node -e "require('http').get('http://localhost:3001/health',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.exit(JSON.parse(d).status==='healthy'?0:1))})"

CMD ["node", "dist/index.js"]
