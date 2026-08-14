.DEFAULT_GOAL := help
COMPOSE := docker compose -f docker-compose.yml -f docker-compose.dev.yml

.PHONY: help setup up down logs ps psql dev check typecheck lint test fmt generate migrate seed reset rename

help: ## Show this list
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

setup: ## Create .env and install dependencies
	@test -f .env || cp .env.example .env
	pnpm install

up: ## Start Postgres and wait until it is healthy
	$(COMPOSE) up -d --wait

down: ## Stop containers
	$(COMPOSE) down

logs: ## Follow container logs
	$(COMPOSE) logs -f

ps: ## Container status
	$(COMPOSE) ps

psql: ## Open a psql shell on the app database
	$(COMPOSE) exec postgres psql -U app -d app

dev: ## Run every app in development mode
	pnpm dev

generate: ## Generate a migration from schema changes (usage: make generate name=add_settings)
	pnpm --filter @app/api db:generate --name=$(name)

migrate: ## Apply pending migrations
	pnpm --filter @app/api migrate

seed: ## Seed permissions, system roles and the owner account (idempotent)
	pnpm --filter @app/api seed

reset: ## Drop the database volume, then migrate and seed from scratch
	$(COMPOSE) down -v
	$(COMPOSE) up -d --wait
	$(MAKE) migrate seed

check: ## The gate: format:check + typecheck + lint + test
	pnpm check

typecheck: ## Type-check the whole workspace
	pnpm typecheck

lint: ## ESLint the whole workspace
	pnpm lint

test: ## Vitest the whole workspace
	pnpm test

fmt: ## Format with Prettier
	pnpm format

rename: ## Rename this template (usage: make rename name=my-project)
	node scripts/rename.mjs --name=$(name)
