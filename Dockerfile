FROM node:24.15.0-bookworm-slim AS build
WORKDIR /opt/repropack
COPY package.json package-lock.json ./
RUN npm ci
COPY web ./web
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm run build && npm prune --omit=dev && npm cache clean --force

FROM node:24.15.0-bookworm-slim AS runtime
WORKDIR /opt/repropack
ENV NODE_ENV=production REPROPACK_PORT=4317 REPROPACK_LISTEN_HOST=0.0.0.0 REPROPACK_DATA_DIR=/var/lib/repropack
LABEL org.opencontainers.image.title="ReproPack" org.opencontainers.image.version="0.6.0-alpha.2"
RUN groupadd --gid 10001 repropack && useradd --uid 10001 --gid 10001 --no-create-home repropack \
    && mkdir -p /var/lib/repropack && chown 10001:10001 /var/lib/repropack
COPY --from=build /opt/repropack/node_modules ./node_modules
COPY --from=build /opt/repropack/dist ./dist
COPY package.json package-lock.json LICENSE ./
COPY src ./src
COPY scripts/healthcheck.mjs scripts/backup.mjs scripts/restore.mjs ./scripts/
COPY examples/cart-discount.json examples/postgres-cart.json ./examples/
COPY examples/postgres-app ./examples/postgres-app
USER 10001:10001
EXPOSE 4317
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "src/server.ts"]
