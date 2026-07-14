FROM node:20-bookworm-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/server-web/package.json apps/server-web/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci

FROM deps AS build

COPY tsconfig.base.json ./
COPY apps apps
COPY packages packages

RUN npm run build --workspaces

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/server-web/package.json apps/server-web/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci --omit=dev \
  --workspace @codex-usage-dashboard/server \
  --workspace @codex-usage-dashboard/shared \
  --include-workspace-root=false \
  && npm cache clean --force

COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/public apps/server/public
COPY --from=build /app/packages/shared/dist packages/shared/dist

USER node

EXPOSE 3000

CMD ["node", "apps/server/dist/index.js"]
