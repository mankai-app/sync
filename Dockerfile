FROM oven/bun:1.3.14-slim
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun drizzle ./drizzle
RUN mkdir -p /app/data && chown bun:bun /app/data

USER bun
EXPOSE 3000
CMD ["bun", "run", "src/index.ts", "/app/config.json"]
