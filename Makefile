.PHONY: setup dev lint typecheck test e2e verify fixtures

setup:
	uv sync --all-extras
	pnpm install --frozen-lockfile

dev:
	pnpm dev

lint:
	uv run ruff check .
	uv run ruff format --check .
	pnpm lint
	pnpm format:check

typecheck:
	uv run python -m mypy
	pnpm typecheck

test:
	uv run python -m pytest
	pnpm test

e2e:
	pnpm e2e

verify: lint typecheck test e2e

fixtures:
	uv run python scripts/generate_fixtures.py
