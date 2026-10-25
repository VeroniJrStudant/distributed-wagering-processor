FROM oven/bun:1.2
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN chmod +x docker/entrypoint.sh docker/localstack-init.sh
EXPOSE 3000
ENTRYPOINT ["docker/entrypoint.sh"]
