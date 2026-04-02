FROM node:22-bookworm-slim

WORKDIR /app

ARG PUBLIC_API_URL=http://localhost:8080
ARG PUBLIC_GAME_SERVER_URL=http://localhost:8091
ENV VITE_API_BASE_URL=$PUBLIC_API_URL
ENV VITE_GAME_SERVER_URL=$PUBLIC_GAME_SERVER_URL

COPY . .

RUN npm --version && npm install --workspaces --include-workspace-root --loglevel=verbose
RUN npm run build --workspace=@avara/web-player

EXPOSE 3000

CMD ["npm", "run", "preview", "--workspace=@avara/web-player", "--", "--host", "0.0.0.0", "--port", "3000"]
