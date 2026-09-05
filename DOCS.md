## Installation

For local development, copy this repository into a named directory under Home Assistant's local
`/addons` directory, reload the app store, then install **Plotbox** from Local apps. The repository
root is the app folder because its Docker build needs the frontend, backend, and shared packages.

The build supports `amd64` and `aarch64`. It compiles the Vite frontend, installs the Python package,
and serves both on internal port 5616.

## Storage and backups

Home Assistant mounts `/data` as persistent storage. Plotbox stores:

- projects below `/data/projects`;
- the FluidNC endpoint in `/data/fluidnc.json`;
- generated exports inside each project directory.

The app declares cold backups so these ordinary files are captured in a stopped, consistent state.

## Network and TLS

Use **Open Web UI** or the Plotbox sidebar item. Ingress is enabled and streams job events. The
container intentionally serves HTTP; TLS belongs at Home Assistant's reverse proxy. Static assets,
API requests, and event streams use the current Ingress prefix.

Host port 5616 is published for a trusted reverse proxy such as Nginx Proxy Manager. The packaged
allowlist accepts RFC1918 private IPv4 clients (including a direct `192.168.x.x` browser), the
Home Assistant/container networks, and loopback. This supports both direct trusted-LAN access and
reverse-proxy access without trusting forwarded headers. Keep the application unreachable directly
from the public internet; Plotbox has no user accounts. A custom deployment can replace
`PLOTTERAPP_ALLOWED_CLIENT_NETWORKS` with a narrower comma-separated CIDR list.

