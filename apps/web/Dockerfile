# SvelteKit frontend (adapter-auto -> node build)
FROM oven/bun:1.3-alpine AS build
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .
RUN bun run build

FROM oven/bun:1.3-alpine
WORKDIR /app
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./
ENV PORT=5173
EXPOSE 5173
# adapter-auto emits a node server at build/index.js
CMD ["bun", "run", "build/index.js"]
