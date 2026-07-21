# Bun + Hono backend API
FROM oven/bun:1.3-alpine

WORKDIR /app
COPY package.json ./
RUN bun install

COPY . .

ENV PORT=9001
EXPOSE 9001
CMD ["bun", "run", "src/server.ts"]
