FROM guergeiro/pnpm:22-10-slim

WORKDIR /app

ARG VITE_API_BASE_URL=http://api:8080
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

COPY . .

RUN pnpm --version && pnpm install --no-frozen-lockfile --reporter append-only
RUN pnpm --filter @avara/admin build

EXPOSE 3001

CMD ["pnpm", "--filter", "@avara/admin", "preview", "--", "--host", "0.0.0.0", "--port", "3001"]
