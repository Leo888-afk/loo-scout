# Loo Scout uses Node's built-in node:sqlite — no native build tools needed.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/looscout.db
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
VOLUME /data
EXPOSE 8080
CMD ["node", "src/server.js"]
