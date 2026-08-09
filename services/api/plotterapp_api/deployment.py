from __future__ import annotations

import ipaddress
from collections.abc import Sequence

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.types import ASGIApp


class AllowedClientNetworksMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp, networks: Sequence[str]) -> None:
        super().__init__(app)
        self.networks = tuple(ipaddress.ip_network(value, strict=False) for value in networks)

    async def dispatch(
        self,
        request: Request,
        call_next: RequestResponseEndpoint,
    ) -> Response:
        client_host = request.client.host if request.client is not None else ""
        try:
            client_address = ipaddress.ip_address(client_host)
        except ValueError:
            return JSONResponse(
                status_code=403,
                content={"detail": "client address is not allowed"},
            )
        if not any(client_address in network for network in self.networks):
            return JSONResponse(
                status_code=403,
                content={"detail": "client address is not allowed"},
            )
        return await call_next(request)
