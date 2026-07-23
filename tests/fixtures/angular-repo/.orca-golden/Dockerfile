# syntax=docker/dockerfile:1
# ORCA synthesized image — recipe node-angular (node).
FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 4200
CMD npm run start -- --host 0.0.0.0 --port 4200
