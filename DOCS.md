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

Host port 5616 is published for a trusted reverse proxy such as Nginx Proxy Manager. The Home
Assistant package restricts clients to the Ingress gateway, container loopback, and any explicitly
configured `PLOTTERAPP_ALLOWED_CLIENT_NETWORKS` proxy networks. Add the proxy's source network to
that setting and keep the application unreachable directly from the public internet.

The FluidNC connection originates from the app container. Ensure Home Assistant can route to the
configured hostname/IP and FluidNC WebSocket port (normally 81). Do not enable `wss` unless the
controller endpoint itself provides TLS.

## Commissioning safety

Open **Plotter setup** and run read-only checks first. Homing, jog, and pen-actuator tests require a
fresh confirmation and are bounded by the API. Feed hold is available at the top of the setup page.
Plotbox does not expose arbitrary G-code, unlock/reset, work-zero changes, or automatic FluidNC
configuration writes.

The calibration test menu provides eleven named patterns: scale grid, circle/arc, diagonal/skew,
backlash ladder, speed, Z-depth/pen pressure, lift delay, registration, pen swatches, line spacing,
and hatch density. Each pattern has bounded area, feed, Z, and complexity controls and is generated
server-side as an allowlisted sequence. A swatch sheet is for the currently mounted pen; repeat it
after changing pens.

Axis calibration calculates a suggested steps/mm value only. Apply it manually to the FluidNC
configuration after reviewing the controller documentation, restart, and measure again.
