FROM node:22-bookworm-slim

WORKDIR /app

COPY . .

RUN npm --version && npm install --workspaces --include-workspace-root --loglevel=verbose

EXPOSE 8090

CMD ["node", "apps/matchmaker/src/server.ts"]
