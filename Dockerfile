# Cloud Run — Express WS proxy + build statica Vite (single-server).
FROM node:24-slim
WORKDIR /app

# deps (incluse devDeps: serve vite per build + google-auth-library)
COPY package*.json ./
RUN npm install

# codice + build frontend
COPY . .
RUN npm run build

ENV NODE_ENV=production
# Cloud Run inietta PORT (default 8080); proxy.js usa process.env.PORT
EXPOSE 8080
CMD ["node", "server/proxy.js"]
