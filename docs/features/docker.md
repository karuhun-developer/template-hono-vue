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

## Redis

Nothing in the default configuration needs it — the queue is Postgres and the cache is
in-process. It ships behind a compose profile, so `make up` stays a one-container stack:

```bash
make up-redis   # Postgres 7332 · Redis 7379
```

Two things about that service are deliberate. It has **no volume and no persistence**
(`--save '' --appendonly no`): a development Redis holding a job queue across restarts is a
source of jobs from a schema three branches ago. And the port is **7379**, for the same
reason Postgres is on 7332 — a development machine usually already has one on the default.

Point a subsystem at it with `REDIS_URL` plus the driver setting that wants it
(`QUEUE_DRIVER=redis`). The API refuses to boot if one is set without the other; an
environment variable that is not validated in `apps/api/src/env.ts` is one that fails three
hours into a request instead of in the first second of boot.

## Mailpit

A mail server that accepts everything and delivers nothing, so `MAIL_DRIVER=smtp` is
exercisable without a provider account and without anything reaching a real inbox:

```bash
make up-mail    # SMTP on 1025 · inbox on http://localhost:8025
```

```dotenv
MAIL_DRIVER=smtp
SMTP_HOST=localhost
SMTP_PORT=1025
```

It is the **one service defined only in the dev overlay**, and that is the point: a fake mail
server is not a thing a production stack should be able to grow by accident, and unlike
Postgres and Redis there is no production counterpart of it to configure. Messages are kept
in memory only — a development mailbox that survives a restart is a mailbox somebody
eventually reads a stale link out of.

Under the default `MAIL_DRIVER=log` none of this is needed; see [Mail](mail.md).

## Conventions

- New services go in `docker-compose.yml`; **ports go only in the dev overlay.** Mailpit is the documented exception, and the section above says why.
- Every service gets a healthcheck. `--wait` is only as good as the checks behind it.
- Every new setting gets an entry in `.env.example`, under a `# ===` header with a line saying what it does.
- Never put a secret in a compose file. `.env` is git-ignored; `.env.example` holds placeholders.
- Change `docker/postgres/init/` and you must `make reset`, or apply the change by hand.
