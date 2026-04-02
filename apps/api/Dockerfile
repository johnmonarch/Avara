FROM guergeiro/pnpm:22-10-slim

WORKDIR /app

COPY . .

RUN pnpm --version && pnpm install --no-frozen-lockfile --reporter append-only

EXPOSE 8080

CMD ["node", "apps/api/src/server.ts"]
