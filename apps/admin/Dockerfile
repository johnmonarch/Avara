FROM node:22-bookworm-slim

WORKDIR /app

ARG PUBLIC_API_URL=http://localhost:8080
ENV VITE_API_BASE_URL=$PUBLIC_API_URL

COPY . .

RUN npm --version && npm install --workspaces --include-workspace-root --loglevel=verbose
RUN npm run build --workspace=@avara/admin

EXPOSE 3001

CMD ["npm", "run", "preview", "--workspace=@avara/admin", "--", "--host", "0.0.0.0", "--port", "3001"]
