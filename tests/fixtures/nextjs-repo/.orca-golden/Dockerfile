# syntax=docker/dockerfile:1
# ORCA synthesized image — recipe node-next (node).
FROM node:20 AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build
FROM node:20-slim
WORKDIR /app
COPY --from=builder /app /app
EXPOSE 3000
CMD npm run start
