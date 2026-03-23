# Build portfolio RAG frontend (React/Vite).
# From rag-chat: docker build -f portfolio-rag-frontend/Dockerfile -t portfolio-rag-frontend .

FROM node:20-alpine

WORKDIR /app

COPY portfolio-rag-frontend/package*.json ./
RUN npm install

COPY portfolio-rag-frontend/ ./
RUN npm run build

# Output: dist/ with static files (served by portfolio Rag server in production)
