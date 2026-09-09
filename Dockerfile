# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# Bun's standalone compiler inherits the builder libc even with the baseline
# target. Build on GNU libc because Box machines run Debian.
FROM oven/bun:1.4.2-debian@sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73 AS build
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
COPY scripts/lib/pinned-bun.ts ./scripts/lib/pinned-bun.ts
COPY scripts/lib/agent-release.ts ./scripts/lib/agent-release.ts
RUN bun run --cwd apps/web build && bun scripts/build-agent.ts

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS agent-runtime-check
COPY --from=build /app/dist /app/dist
RUN set -eu; output=/tmp/companion-agent-startup; \
    if env -u AGENT_TOKEN /app/dist/agent/companion-agent >"$output" 2>&1; then exit 1; fi; \
    test "$(cat "$output")" = MISSING_AGENT_TOKEN; rm -f "$output"

FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f
WORKDIR /app
ENV NODE_ENV=production \
    COMPANIONS_SCHEMA_PREPARED=1 \
    COMPANIONS_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_DIST=/app/apps/web/dist \
    LOCAL_RUNTIME=0

COPY --chown=bun:bun --from=build /app/node_modules ./node_modules
COPY --chown=bun:bun --from=build /app/apps/server ./apps/server
COPY --chown=bun:bun --from=build /app/apps/web/dist ./apps/web/dist
COPY --chown=bun:bun --from=build /app/packages ./packages
COPY --chown=bun:bun --from=agent-runtime-check /app/dist ./dist
COPY --chown=bun:bun scripts/lib/distribution-verification.ts scripts/lib/template-install.ts ./scripts/lib/
COPY --chown=bun:bun scripts/container-entrypoint.sh ./scripts/container-entrypoint.sh
RUN mkdir -p /data && chown bun:bun /data
USER bun

EXPOSE 3000
ENTRYPOINT ["/app/scripts/container-entrypoint.sh"]
CMD ["api"]
