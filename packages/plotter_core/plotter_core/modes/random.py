from __future__ import annotations

import hashlib
import random
import unicodedata
from dataclasses import dataclass

_DERIVATION_DOMAIN = b"plotterapp.named-random-stream.v1"


def normalize_seed(seed: str) -> str:
    """Return the stable persisted representation of a user-provided seed."""
    if not isinstance(seed, str):
        raise TypeError("seed must be a string")
    normalized = unicodedata.normalize("NFC", seed)
    if not normalized.strip():
        raise ValueError("seed must not be empty")
    try:
        normalized.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError("seed must contain valid Unicode") from error
    return normalized


def _encode_part(label: str, value: str) -> bytes:
    normalized = unicodedata.normalize("NFC", value)
    if not normalized:
        raise ValueError(f"{label} must not be empty")
    try:
        encoded = normalized.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError(f"{label} must contain valid Unicode") from error
    return len(encoded).to_bytes(4, "big") + encoded


@dataclass(frozen=True)
class NamedRandomStreams:
    """Mode-scoped deterministic random streams derived without mutable global state."""

    seed: str
    mode_id: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "seed", normalize_seed(self.seed))
        _encode_part("mode ID", self.mode_id)

    def digest(self, name: str) -> bytes:
        payload = b"".join(
            (
                _DERIVATION_DOMAIN,
                _encode_part("seed", self.seed),
                _encode_part("mode ID", self.mode_id),
                _encode_part("stream name", name),
            )
        )
        return hashlib.sha256(payload).digest()

    def scalar(self, name: str) -> random.Random:
        """Create an independent stdlib random stream."""
        return random.Random(int.from_bytes(self.digest(name), "big"))

    def numpy_seed_sequence(self, name: str) -> tuple[int, ...]:
        """Return uint32 entropy words suitable for ``numpy.random.SeedSequence``."""
        digest = self.digest(name)
        return tuple(
            int.from_bytes(digest[offset : offset + 4], "big")
            for offset in range(0, len(digest), 4)
        )
