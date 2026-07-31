# syntax=docker/dockerfile:1
# ORCA synthesized image — recipe node-react (node).
FROM node:20-slim
ENV NODE_ENV=development
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 5173
CMD npm run dev
