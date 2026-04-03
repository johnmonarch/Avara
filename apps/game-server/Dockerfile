FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends g++ \
  && rm -rf /var/lib/apt/lists/*

COPY . .

RUN npm --version && npm install --workspaces --include-workspace-root --loglevel=verbose
RUN node packages/native-core/scripts/build-native.mjs

EXPOSE 8091

CMD ["node", "apps/game-server/src/server.ts"]
