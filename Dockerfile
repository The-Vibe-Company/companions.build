# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY apps/web/package.json apps/web/bun.lock ./apps/web/
RUN cd apps/web && bun install --frozen-lockfile

COPY tsconfig.json ./
COPY apps/web ./apps/web
COPY apps/server ./apps/server
COPY packages ./packages
COPY scripts/build-agent.ts ./scripts/build-agent.ts
RUN bun run --cwd apps/web build && bun scripts/build-agent.ts

FROM docker:28.4.0-cli-alpine3.22@sha256:6a73c9433f2ba4279815be1e60f5739288b939dda1e48151d8c393537802de37 AS docker-cli

FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f
WORKDIR /app
ENV NODE_ENV=production \
    COMPANIONS_SCHEMA_PREPARED=1 \
    COMPANIONS_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_DIST=/app/apps/web/dist \
    LOCAL_RUNTIME=0

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --chown=bun:bun --from=build /app/node_modules ./node_modules
COPY --chown=bun:bun --from=build /app/apps/server ./apps/server
COPY --chown=bun:bun --from=build /app/apps/web/dist ./apps/web/dist
COPY --chown=bun:bun --from=build /app/packages ./packages
COPY --chown=bun:bun --from=build /app/dist ./dist
COPY --chown=bun:bun scripts/container-entrypoint.sh ./scripts/container-entrypoint.sh
RUN mkdir -p /data && chown bun:bun /data
USER bun

EXPOSE 3000
ENTRYPOINT ["/app/scripts/container-entrypoint.sh"]
CMD ["api"]
