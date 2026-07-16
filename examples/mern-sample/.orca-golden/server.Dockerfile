# syntax=docker/dockerfile:1
# ORCA Stage 1 — Node service (React client or Express server), dev mode.
FROM node:20-slim
ENV NODE_ENV=development
WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 5000

CMD npm run dev
