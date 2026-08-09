from __future__ import annotations

from collections.abc import Callable
from typing import Any

from plotter_core.models import ProjectRecipe

Migration = Callable[[dict[str, Any]], dict[str, Any]]
LATEST_PROJECT_SCHEMA_VERSION = 1
PROJECT_MIGRATIONS: dict[int, Migration] = {}


def migrate_project(payload: dict[str, Any]) -> ProjectRecipe:
    """Validate or migrate a durable recipe to the current schema."""
    version = payload.get("schema_version")
    if not isinstance(version, int):
        raise ValueError("project schema_version must be an integer")
    if version > LATEST_PROJECT_SCHEMA_VERSION:
        raise ValueError(f"unsupported future project schema version: {version}")
    migrated = dict(payload)
    while version < LATEST_PROJECT_SCHEMA_VERSION:
        migration = PROJECT_MIGRATIONS.get(version)
        if migration is None:
            raise ValueError(f"no migration registered for project schema version {version}")
        migrated = migration(migrated)
        version += 1
    return ProjectRecipe.model_validate(migrated)
