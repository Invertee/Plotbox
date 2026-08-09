FROM node:22-bookworm-slim AS web-builder

WORKDIR /source
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN corepack enable && pnpm install --frozen-lockfile
COPY apps/web apps/web
RUN pnpm --filter @plotterapp/web build

FROM python:3.12-slim-bookworm AS runtime

ARG BUILD_VERSION=0.3.0
ARG BUILD_ARCH=amd64

LABEL io.hass.version="${BUILD_VERSION}" \
      io.hass.type="app" \
      io.hass.arch="${BUILD_ARCH}"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/usr/local/bin:${PATH}" \
    PLOTTERAPP_PROJECTS_ROOT=/data/projects \
    PLOTTERAPP_FLUIDNC_CONFIG=/data/fluidnc.json \
    PLOTTERAPP_WEB_ROOT=/app/web

WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /uvx /bin/
COPY pyproject.toml uv.lock README.md ./
COPY packages packages
COPY services services
RUN uv sync --frozen --no-dev --no-editable
COPY --from=web-builder /source/apps/web/dist /app/web

EXPOSE 5616
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5616/api/health', timeout=3).read()"]

CMD ["/app/.venv/bin/uvicorn", "plotterapp_api.main:app", "--host", "0.0.0.0", "--port", "5616", "--no-proxy-headers"]
