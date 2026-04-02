FROM node:22-bookworm-slim

WORKDIR /app

COPY . .

RUN npm --version && npm install --workspaces --include-workspace-root --loglevel=verbose

EXPOSE 8091

CMD ["node", "apps/game-server/src/server.ts"]
