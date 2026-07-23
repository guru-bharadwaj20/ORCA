# syntax=docker/dockerfile:1
# ORCA synthesized image — recipe node-vite (node).
FROM node:20 AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build
FROM node:20-slim
WORKDIR /app
COPY --from=builder /app /app
EXPOSE 4173
CMD npx vite preview --host 0.0.0.0 --port 4173
