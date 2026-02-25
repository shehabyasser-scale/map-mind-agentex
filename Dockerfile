FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY public/ ./public/
COPY server.js ./
COPY data/ ./data/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
