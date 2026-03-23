# Build and run portfolio RAG server (Node + Express).
# Build context: parent of "portfolio Rag server" (must contain portfolio-rag-frontend/ and portfolio Rag server/).
# Run from portfolio Rag server: docker compose up -d

# Stage 1: Build frontend (portfolio-rag-frontend)
FROM node:20-alpine AS frontend
WORKDIR /app
COPY portfolio-rag-frontend/package*.json ./
RUN npm install
COPY portfolio-rag-frontend/ ./
RUN npm run build

# Stage 2: Server
FROM node:20-alpine

WORKDIR /app/rag-chat

# JSON-array COPY: required for paths that contain spaces (shell form breaks the parser)
COPY ["portfolio Rag server/package.json", "portfolio Rag server/package-lock.json", "./"]
RUN npm install --legacy-peer-deps

COPY ["portfolio Rag server/", "portfolio Rag server/"]
COPY ["portfolio Rag server/protfolioData.pdf", "./"]

COPY --from=frontend /app/dist portfolio-rag-frontend/dist/

ENV NODE_ENV=production
ENV PDF_PATH=/app/rag-chat/protfolioData.pdf
EXPOSE 3001

CMD ["sh", "-c", "node \"portfolio Rag server/indexing.js\" && node \"portfolio Rag server/index.js\""]
