FROM node:20-slim
WORKDIR /app

# Install OpenSSL for Prisma
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma/

# Install all deps (including dev) for prisma generate
RUN npm install

# Generate Prisma client
RUN npx prisma generate

# Remove dev dependencies
RUN npm prune --omit=dev

COPY server.js db.js redis.js ./
COPY client ./client/

EXPOSE 4000
ENV PORT=4000

CMD ["node", "server.js"]
