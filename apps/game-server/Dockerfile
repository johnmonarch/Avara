FROM node:22-alpine

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app

COPY . .

RUN pnpm install --no-frozen-lockfile

EXPOSE 8091

CMD ["node", "apps/game-server/src/server.ts"]
