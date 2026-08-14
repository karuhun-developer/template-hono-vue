# Docker

Compose runs **PostgreSQL only**. The Node processes run on the host, because hot reload through `tsx watch` and Vite is far nicer outside a container and there is nothing to gain from putting them in one during development.

| File                                    | For                                                            |
| --------------------------------------- | -------------------------------------------------------------- |
| `docker-compose.yml`                    | The base: the Postgres service, its volume and its healthcheck |
| `docker-compose.dev.yml`                | Development overlay: publishes the port, logs slow statements  |
| `docker-compose.prod.yml`               | Production overlay: no published ports, tuned settings         |
| `docker/postgres/init/01-databases.sql` | Creates `app_test` on first boot                               |

> **Never run the base file alone.** Always pair it with an overlay. `make up` chains them for you:
> `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --wait`

## Ports

| Service  | Port | Why that one                                                |
| -------- | ---- | ----------------------------------------------------------- |
| API      | 7300 |                                                             |
| Console  | 7301 |                                                             |
| Postgres | 7332 | A development machine usually already runs Postgres on 5432 |

They are deliberately unusual so they do not collide with whatever else is on the machine. Every frontend sets `strictPort: true`, so a busy port fails loudly instead of silently moving — a moved port is no longer in `CORS_ORIGINS`, and the resulting preflight failure has no obvious cause.

## Everyday commands

```bash
make up        # start and wait until healthy (--wait, so `make migrate` cannot race it)
make down      # stop
make ps        # status
make logs      # follow
make psql      # a psql shell on the app database
make reset     # drop the volume, migrate and seed from scratch
```

`--wait` matters: without it `make up && make migrate` races the healthcheck, and the migration fails against a database that is still starting.

## The two databases

`app` and `app_test`, so `pnpm test` can never drop somebody's development data. `app_test` is created by `docker/postgres/init/01-databases.sql`, and **the entrypoint only runs init scripts on a volume that is empty**. If you add a database to that file later:

```bash
make reset                                              # or, without losing data:
docker compose exec postgres createdb -U app app_test
```

## Development overlay

Publishes `${POSTGRES_PORT:-7332}:5432` so `pnpm dev`, `drizzle-kit` and a host `psql` can connect, and turns on:

```text
log_min_duration_statement=200
```

Every statement slower than 200 ms is logged — enough to catch a missing index while the table is still small, without drowning the log in trivial `SELECT`s. Read them with `make logs`.

## Production overlay

Note what it does **not** have: published ports. In production the API reaches Postgres over the compose network and nothing else should be able to. It also sets `restart: unless-stopped`, raises `shared_buffers` / `effective_cache_size` for roughly 2 GB of RAM, and logs statements over 1 s. Tune those for the box you actually run on.

## Packaging the API

There is no application image here, and `pnpm --filter @app/api build` prints a note and exits `0`. The API runs straight from TypeScript through `tsx`.

That is a deliberate omission: shipping a Dockerfile nobody has deployed with is how a template hands you a broken build on day one. When you know how your project deploys, a working starting point is roughly:

```dockerfile
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/contract/package.json packages/contract/
RUN pnpm install --frozen-lockfile --filter @app/api...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY . .
EXPOSE 7300
CMD ["pnpm", "--filter", "@app/api", "start"]
```

Three things to get right whatever you build:

- **Migrations are a separate step**, not part of the container's start command. Two replicas booting at once must not both migrate.
- **`GET /health/ready` is your readiness probe** — it checks the database. `GET /health` is liveness and touches nothing.
- **The frontends are static files.** `pnpm --filter @app/console build` produces `dist/`; serve it from nginx, a CDN, or anything else. It does not need Node at runtime.

## Adding Redis

Nothing in this template needs it — auth and RBAC involve no queue, cache or pub/sub. When you do:

```yaml
# docker-compose.yml
services:
  redis:
    image: redis:8-alpine
    command: ['redis-server', '--appendonly', 'yes']
    volumes:
      - redisdata:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  redisdata:
```

```yaml
# docker-compose.dev.yml
services:
  redis:
    ports:
      - '${REDIS_PORT:-7379}:6379'
```

Then add `REDIS_URL` to `.env.example` and to the schema in `apps/api/src/env.ts` — an environment variable that is not validated there is one that fails three hours into a request instead of in the first second of boot.

## Conventions

- New services go in `docker-compose.yml`; **ports go only in the dev overlay.**
- Every service gets a healthcheck. `--wait` is only as good as the checks behind it.
- Every new setting gets an entry in `.env.example`, under a `# ===` header with a line saying what it does.
- Never put a secret in a compose file. `.env` is git-ignored; `.env.example` holds placeholders.
- Change `docker/postgres/init/` and you must `make reset`, or apply the change by hand.
