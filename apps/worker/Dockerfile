# ── Stage 1: build ─────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Enable pnpm via corepack
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy workspace manifest + lockfile + all package manifests for caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/types/package.json packages/types/
COPY packages/tools-contracts/package.json packages/tools-contracts/

# Install ALL deps including devDependencies for build
RUN pnpm install --frozen-lockfile

# Copy source
COPY apps/worker apps/worker/
COPY packages/db packages/db/
COPY packages/types packages/types/
COPY packages/tools-contracts packages/tools-contracts/

# Build the worker (also builds its workspace dependencies via turbo)
RUN pnpm turbo build --filter=@hale/worker

# Prune devDependencies for the production image
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# ── Stage 2: runtime ───────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

WORKDIR /app

# Run as non-root for safety
RUN groupadd --system --gid 1001 mira && \
    useradd --system --uid 1001 --gid mira mira

# Copy built artifacts + production node_modules. pnpm keeps per-package symlink
# farms (apps/worker/node_modules/* -> ../../node_modules/.pnpm/...), so the
# worker's own node_modules must be copied too — the root store alone doesn't
# make `zod`/`pg-boss`/etc. resolvable from apps/worker/dist.
COPY --from=builder --chown=mira:mira /app/node_modules ./node_modules
COPY --from=builder --chown=mira:mira /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder --chown=mira:mira /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=builder --chown=mira:mira /app/apps/worker/package.json ./apps/worker/
COPY --from=builder --chown=mira:mira /app/packages ./packages
COPY --from=builder --chown=mira:mira /app/package.json ./

USER mira

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

CMD ["node", "apps/worker/dist/index.js"]
