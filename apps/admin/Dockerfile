FROM node:22-alpine

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app

ARG VITE_API_BASE_URL=http://api:8080
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

COPY . .

RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @avara/admin build

EXPOSE 3001

CMD ["pnpm", "--filter", "@avara/admin", "preview", "--", "--host", "0.0.0.0", "--port", "3001"]
