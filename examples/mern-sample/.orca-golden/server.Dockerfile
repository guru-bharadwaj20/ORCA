# syntax=docker/dockerfile:1
# ORCA synthesized image — recipe node-express (node).
FROM node:20-slim
ENV NODE_ENV=development
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 5000
CMD npm run dev
