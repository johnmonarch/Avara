FROM node:22-bookworm-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable && corepack prepare pnpm@10.14.0 --activate

WORKDIR /app

COPY . .

RUN pnpm --version && pnpm install --no-frozen-lockfile --reporter append-only

EXPOSE 8091

CMD ["node", "apps/game-server/src/server.ts"]
