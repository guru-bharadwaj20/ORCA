FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
EXPOSE 9090
CMD ["node", "server.js"]
