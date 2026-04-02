FROM node:22-bookworm-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN npm install -g pnpm@10.14.0

WORKDIR /app

ARG VITE_API_BASE_URL=http://api:8080
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

COPY . .

RUN pnpm --version && pnpm install --no-frozen-lockfile --reporter append-only
RUN pnpm --filter @avara/web-player build

EXPOSE 3000

CMD ["pnpm", "--filter", "@avara/web-player", "preview", "--", "--host", "0.0.0.0", "--port", "3000"]
