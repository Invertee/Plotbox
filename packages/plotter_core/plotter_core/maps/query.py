from __future__ import annotations

import json
import os
import threading
import time
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any, TypedDict

DEFAULT_OVERPASS_ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
)
DEFAULT_NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search"
MAX_RESPONSE_BYTES = 20 * 1024 * 1024
MAX_GEOCODING_RESPONSE_BYTES = 1024 * 1024
OVERPASS_HTTP_TIMEOUT_SECONDS = 120
USER_AGENT = "Plotbox/0.2 local single-user artwork tool"
OsmFetcher = Callable[[str], dict[str, Any]]
_nominatim_lock = threading.Lock()
_last_nominatim_request = 0.0


class OsmPlace(TypedDict):
    display_name: str
    latitude: float
    longitude: float
    osm_type: str | None
    osm_id: int | None


OsmPlaceFetcher = Callable[[str], list[OsmPlace]]


def _overpass_endpoints() -> tuple[str, ...]:
    configured = os.environ.get("PLOTTERAPP_OVERPASS_ENDPOINTS", "")
    endpoints = tuple(item.strip() for item in configured.split(",") if item.strip())
    return endpoints or DEFAULT_OVERPASS_ENDPOINTS


def _post_overpass(endpoint: str, body: bytes) -> dict[str, Any]:
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=OVERPASS_HTTP_TIMEOUT_SECONDS) as response:
        content = response.read(MAX_RESPONSE_BYTES + 1)
    if len(content) > MAX_RESPONSE_BYTES:
        raise ValueError("OSM response exceeds the 20 MiB limit")
    payload = json.loads(content)
    if not isinstance(payload, dict) or not isinstance(payload.get("elements"), list):
        raise ValueError("OSM provider returned an invalid snapshot")
    return payload


def fetch_osm_json(query: str) -> dict[str, Any]:
    body = urllib.parse.urlencode({"data": query}).encode("utf-8")
    errors: list[str] = []
    for endpoint in _overpass_endpoints():
        try:
            return _post_overpass(endpoint, body)
        except (OSError, TimeoutError, json.JSONDecodeError, ValueError) as error:
            host = urllib.parse.urlparse(endpoint).netloc or endpoint
            errors.append(f"{host}: {error}")
    summary = "; ".join(errors)
    raise OSError(f"all configured Overpass providers failed ({summary})")


def _normalize_place(item: object) -> OsmPlace | None:
    if not isinstance(item, dict):
        return None
    try:
        display_name = str(item["display_name"]).strip()
        latitude = float(item["lat"])
        longitude = float(item["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    if not display_name or not (-85 <= latitude <= 85 and -180 <= longitude <= 180):
        return None
    osm_type = item.get("osm_type")
    osm_id = item.get("osm_id")
    return {
        "display_name": display_name,
        "latitude": latitude,
        "longitude": longitude,
        "osm_type": str(osm_type) if osm_type is not None else None,
        "osm_id": int(osm_id) if isinstance(osm_id, int | str) and str(osm_id).isdigit() else None,
    }


def fetch_osm_places(query: str) -> list[OsmPlace]:
    global _last_nominatim_request

    endpoint = os.environ.get("PLOTTERAPP_NOMINATIM_ENDPOINT", DEFAULT_NOMINATIM_ENDPOINT)
    url = f"{endpoint}?{urllib.parse.urlencode({'q': query, 'format': 'jsonv2', 'limit': 5})}"
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        method="GET",
    )
    with _nominatim_lock:
        delay = max(0.0, 1.0 - (time.monotonic() - _last_nominatim_request))
        if delay:
            time.sleep(delay)
        _last_nominatim_request = time.monotonic()
        with urllib.request.urlopen(request, timeout=15) as response:
            content = response.read(MAX_GEOCODING_RESPONSE_BYTES + 1)
    if len(content) > MAX_GEOCODING_RESPONSE_BYTES:
        raise ValueError("OSM place-search response exceeds the 1 MiB limit")
    payload = json.loads(content)
    if not isinstance(payload, list):
        raise ValueError("OSM place-search provider returned an invalid response")
    return [place for item in payload if (place := _normalize_place(item)) is not None][:5]
