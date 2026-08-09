from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

from plotter_core.models import CachePruneReport, CacheStatistics

CACHE_KEY_VERSION = 1


def node_cache_key(
    *,
    operator_name: str,
    operator_version: str,
    input_content_hash: str,
    parameters: dict[str, Any],
    quality: str,
) -> str:
    payload = {
        "schema_version": CACHE_KEY_VERSION,
        "operator_name": operator_name,
        "operator_version": operator_version,
        "input_content_hash": input_content_hash,
        "parameters": parameters,
        "quality": quality,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _atomic_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


class NodeCache:
    """Disposable content-addressed cache with bounded, observable lifecycle."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _data_path(self, key: str) -> Path:
        if len(key) != 64 or any(character not in "0123456789abcdef" for character in key):
            raise ValueError("cache key must be a lowercase SHA-256 digest")
        return self.root / f"{key}.json"

    def _metadata_path(self, key: str) -> Path:
        return self.root / f"{key}.meta.json"

    def get_json(self, key: str) -> dict[str, Any] | None:
        path = self._data_path(key)
        if not path.exists():
            return None
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self.remove(key)
            return None
        if not isinstance(value, dict):
            self.remove(key)
            return None
        now = time.time()
        metadata = {
            "schema_version": 1,
            "key": key,
            "byte_count": path.stat().st_size,
            "created_at_epoch": path.stat().st_ctime,
            "last_accessed_at_epoch": now,
        }
        _atomic_bytes(
            self._metadata_path(key),
            (json.dumps(metadata, sort_keys=True) + "\n").encode("utf-8"),
        )
        return value

    def put_json(self, key: str, value: dict[str, Any]) -> None:
        path = self._data_path(key)
        payload = (
            json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"
        ).encode("utf-8")
        _atomic_bytes(path, payload)
        now = time.time()
        metadata = {
            "schema_version": 1,
            "key": key,
            "byte_count": len(payload),
            "created_at_epoch": now,
            "last_accessed_at_epoch": now,
        }
        _atomic_bytes(
            self._metadata_path(key),
            (json.dumps(metadata, sort_keys=True) + "\n").encode("utf-8"),
        )

    def remove(self, key: str) -> int:
        path = self._data_path(key)
        byte_count = path.stat().st_size if path.exists() else 0
        path.unlink(missing_ok=True)
        self._metadata_path(key).unlink(missing_ok=True)
        return byte_count

    def statistics(self) -> CacheStatistics:
        entries = list(self.root.glob("*.json"))
        data_entries = [path for path in entries if not path.name.endswith(".meta.json")]
        return CacheStatistics(
            entry_count=len(data_entries),
            byte_count=sum(path.stat().st_size for path in data_entries),
        )

    def prune(
        self,
        *,
        max_age_seconds: float | None = None,
        max_bytes: int | None = None,
    ) -> CachePruneReport:
        now = time.time()
        candidates: list[tuple[float, str, int]] = []
        for path in self.root.glob("*.json"):
            if path.name.endswith(".meta.json"):
                continue
            key = path.stem
            accessed_at = path.stat().st_mtime
            metadata_path = self._metadata_path(key)
            if metadata_path.exists():
                try:
                    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                    accessed_at = float(metadata["last_accessed_at_epoch"])
                except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
                    pass
            candidates.append((accessed_at, key, path.stat().st_size))

        removed_entries = 0
        removed_bytes = 0
        retained: list[tuple[float, str, int]] = []
        for accessed_at, key, byte_count in candidates:
            expired = max_age_seconds is not None and now - accessed_at > max_age_seconds
            if expired:
                removed_bytes += self.remove(key)
                removed_entries += 1
            else:
                retained.append((accessed_at, key, byte_count))

        current_bytes = sum(item[2] for item in retained)
        if max_bytes is not None and current_bytes > max_bytes:
            for _, key, byte_count in sorted(retained):
                if current_bytes <= max_bytes:
                    break
                removed_bytes += self.remove(key)
                removed_entries += 1
                current_bytes -= byte_count

        statistics = self.statistics()
        return CachePruneReport(
            removed_entries=removed_entries,
            removed_bytes=removed_bytes,
            remaining_entries=statistics.entry_count,
            remaining_bytes=statistics.byte_count,
        )
