-- Runs once, when the Postgres volume is first initialised.
-- If you change this file, run `make reset` — the entrypoint will not run it again on
-- a volume that already holds data.

-- A separate database for integration tests, so `pnpm test` can never drop someone's
-- development data.
CREATE DATABASE app_test OWNER app;
