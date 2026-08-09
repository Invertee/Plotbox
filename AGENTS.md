# AGENTS.md

This file contains repository-wide instructions for Codex and other coding agents.

## Product boundary

Build a local single-user application for artwork generation, image/map conversion, vector planning,
live preview, G-code file export, and explicitly guarded FluidNC commissioning tools. Supported
deployment targets are local development and a Home Assistant app/add-on served through Ingress or
another trusted reverse proxy that terminates TLS.

The current scope excludes:

- Serial, Telnet, HTTP-upload, or browser-direct controller integration.
- Full G-code streaming, file upload, and unattended plotting.
- Work-zero editing, arbitrary command consoles, and FluidNC `config.yaml` editing.
- Automatic application of calibration values to controller firmware.
- Authentication, accounts, permissions, cloud storage, or collaboration inside Plotbox.

Do not add these features unless the product scope is explicitly changed in `docs/DECISIONS.md`.
FluidNC is both the default export target and an isolated commissioning connection. The approved
commands and safety gates are binding in `docs/DECISIONS.md`.

## Read before changing code

Read, in this order:

1. `docs/MASTER_IMPLEMENTATION_PLAN.md`
2. `docs/DECISIONS.md`
3. The active file in `docs/exec-plans/`
4. `docs/ACCEPTANCE_AND_TEST_PLAN.md`
5. The relevant milestone in `tasks/BACKLOG.md`

For work expected to take more than one focused session, create or update an ExecPlan following
`.agent/PLANS.md` before implementation.

## Architectural invariants

1. Internal design coordinates use millimetres.
2. Page-space origin is lower-left, positive X is right, and positive Y is up.
3. Artwork modes output `DesignDocument`; they never output G-code.
4. Geometry processing creates `PlotPlan`; it remains independent of G-code syntax.
5. Postprocessors convert `PlotPlan` into `GcodeProgram` or another export format.
6. Curves remain curves until a configured flattening or arc-preservation stage.
7. Logical pen roles are separate from preview RGB colors and physical pen profiles.
8. Every generative mode is deterministic for the same recipe, seed, and implementation version.
9. Import and generation work must support cancellation and draft/full quality levels.
10. Every G-code export is parsed back and validated before being offered to the user.
11. The application must function without a database. Artwork workflows remain offline except for
    explicit OpenStreetMap requests; FluidNC tools make only user-initiated connections to the
    configured controller.
12. Do not use SVG as the canonical internal model.
13. Controller connectivity remains isolated from `DesignDocument`, `PlotPlan`, and postprocessor
    code. Controller responses never mutate artwork geometry.
14. Every motion-producing controller action is typed, allowlisted, bounded, and requires explicit
    user confirmation. There is no arbitrary G-code console.

## Preferred stack

- Frontend: React, TypeScript, Vite, strict TypeScript.
- Backend: Python 3.12, FastAPI, Pydantic v2.
- Package managers: `pnpm` for JavaScript and `uv` for Python.
- Tests: pytest, Hypothesis, Vitest, React Testing Library, Playwright.
- Quality: Ruff, strict Python type checking, ESLint, Prettier.
- Geometry: NumPy, Shapely/GEOS; add other dependencies only when justified by a concrete mode.

Do not replace the stack without recording a decision and migration plan.

## Development commands

The repository must converge on these commands:

```bash
make setup
make dev
make lint
make typecheck
make test
make e2e
make verify
```

`make verify` is the required pre-commit and milestone-completion command. It must run formatting or
format checks, linting, type checks, unit tests, integration tests, and the offline golden tests that
are practical in CI.

If the commands do not exist yet, the active bootstrap ExecPlan must create them.

## Implementation style

- Prefer small typed modules with explicit inputs and outputs.
- Keep UI state, project state, geometry state, and export state distinct.
- Keep mutable global state out of geometry and generator code.
- Use explicit dataclasses or Pydantic models at durable boundaries.
- Use NumPy arrays or compact path structures for dense geometry; do not represent millions of
  points as deeply nested Python dictionaries or browser JSON objects.
- Use schema version fields for persisted project data.
- Store generator and operator versions in project metadata.
- Write migrations when changing durable schemas.
- Keep file-format parsing isolated from core geometry.
- Keep controller-specific G-code details isolated in postprocessor modules.
- Avoid speculative abstractions that are not exercised by the current milestone.

## Determinism

A generator must not use module-global randomness. Derive named random streams from the project seed,
for example:

```text
hash(project_seed, "layout")
hash(project_seed, "glyphs")
hash(project_seed, "connectors")
hash(project_seed, "colors")
```

Changing a color setting should not unexpectedly rearrange glyph placement. Golden fixtures should
record stable geometry hashes after normalization.

## G-code requirements

- Default output is FluidNC/Grbl-compatible G-code, exported to disk only.
- Support separate files per pass and one combined file with configurable pen-change pauses.
- Always start and finish with an abstract pen-up action compiled through the selected actuator.
- Validate units, coordinates, feeds, Z values, bounds, path continuity, and supported commands.
- The first implementation may flatten all curves to G1 segments. Arc output is a later optimization.
- No generated program may write firmware settings or issue homing, reset, unlock, or network commands.
- Custom macros must be clearly separated from generated motion and validated against an allowlist.

## Tests required with each feature

Every change must add or update the appropriate tests:

- Unit tests for pure geometry and transforms.
- Property tests for geometry invariants.
- Golden fixtures for deterministic generators and G-code.
- Parser round-trip tests for exported G-code.
- API contract tests.
- UI tests for material user behavior.
- Performance fixtures when a change affects dense geometry.

Never update a golden fixture merely to make a failing test pass. Explain and review the intended
behavioral change first.

## Safety and reliability

This app can perform explicitly confirmed commissioning motions and exports G-code that can later be
used on a machine. Therefore:

- Treat out-of-bounds paths as blocking errors by default.
- Treat non-finite coordinates and invalid Z values as blocking errors.
- Provide a dry-run export that never lowers the pen.
- Provide a page-boundary export.
- Display warnings before exporting unsupported or approximated SVG features.
- Do not silently discard geometry; count and report removed or simplified paths.
- Keep conservative jog-distance and feed limits in the API, not only in the UI.
- Require an explicit confirmation field for homing, jogging, and actuator motion.
- Keep a realtime feed-hold action in the FluidNC setup screen.
- Never expose arbitrary controller commands or write firmware settings from calibration results.

## Scope discipline

Do not spend time on:

- User accounts or authorization.
- Database migrations.
- Docker orchestration for production services.
- Full-project machine senders before the guarded commissioning workflow is validated.
- FluidNC configuration editors or automatic firmware-setting writes.
- Electron or Tauri packaging before the browser-plus-local-service MVP is complete.
- A general-purpose vector editor.

When an idea is useful but outside the active milestone, add it to `tasks/BACKLOG.md` under a later
milestone instead of implementing it opportunistically.

## Completing a task

A task is complete only when:

1. Acceptance criteria are met.
2. Tests cover the behavior.
3. `make verify` passes.
4. User-facing behavior is documented where necessary.
5. Durable schema changes include versioning or migration notes.
6. The active ExecPlan has updated progress, decisions, and outcomes.
7. Any hardware-control behavior is explicitly approved in `docs/DECISIONS.md` and covered by the
   active ExecPlan's safety tests.
