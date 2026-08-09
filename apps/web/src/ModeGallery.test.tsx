import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { ModeGallery } from "./ModeGallery";
import type { ModeManifest } from "./types";

const mode: ModeManifest = {
  schema_version: 1,
  kind: "generator",
  id: "builtin.flow-field",
  version: "1.0.0",
  name: "Flow Field",
  description: "Streamlines",
  category: "procedural",
  quality_levels: ["draft", "standard", "export"],
  semantic_roles: ["structure"],
  parameter_schema_version: 1,
  parameter_groups: [],
  parameters: [
    {
      key: "seed",
      label: "Seed",
      kind: "seed",
      group: "composition",
      default: "flow-1",
      description: "",
      unit: "",
      minimum: null,
      maximum: null,
      step: null,
      options: [],
    },
  ],
  presets: [],
  algorithms: [],
  parameter_schema: null,
  default_complexity: { paths: 120, vertices: 7200, relative_work: 1 },
};

it("shows mode cards and selects schema defaults", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(<ModeGallery modes={[mode]} activeModeId="" onSelect={onSelect} />);
  expect(screen.getByText(/~120 paths/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Flow Field/ }));
  expect(onSelect).toHaveBeenCalledWith(
    expect.objectContaining({ mode_id: "builtin.flow-field", seed: "flow-1" }),
  );
});

it("selects a Glyphscape preset through the generic gallery contract", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const glyphscape: ModeManifest = {
    ...mode,
    id: "builtin.glyphscape",
    name: "Glyphscape",
    description: "Hierarchical routed glyphs",
    semantic_roles: ["glyph-structure", "connector-primary"],
    presets: [
      {
        schema_version: 1,
        preset_id: "city-circuit",
        version: 1,
        mode_id: "builtin.glyphscape",
        mode_version: "1.0.0",
        name: "City Circuit",
        description: "",
        parameter_schema_version: 1,
        seed: "glyphscape-city-1",
        parameters: { theme: "city", density: 0.72 },
      },
    ],
  };
  render(<ModeGallery modes={[glyphscape]} activeModeId="" onSelect={onSelect} />);
  await user.click(screen.getByRole("button", { name: /Glyphscape/ }));
  expect(onSelect).toHaveBeenCalledWith(
    expect.objectContaining({
      mode_id: "builtin.glyphscape",
      seed: "glyphscape-city-1",
      parameters: { theme: "city", density: 0.72 },
    }),
  );
});

it("selects Map-to-Glyphscape presets through the generic gallery contract", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const hybrid: ModeManifest = {
    ...mode,
    id: "builtin.map-glyphscape",
    name: "Map-to-Glyphscape",
    category: "hybrid",
    description: "Locked map topology with source-derived glyphs",
    semantic_roles: ["hybrid-locked-road", "glyph-structure"],
    presets: [
      {
        schema_version: 1,
        preset_id: "circuit-metropolis",
        version: 1,
        mode_id: "builtin.map-glyphscape",
        mode_version: "1.0.0",
        name: "Circuit Metropolis",
        description: "",
        parameter_schema_version: 1,
        seed: "hybrid-circuit-1",
        parameters: { theme: "city", geographic_fidelity: 75 },
      },
    ],
  };
  render(<ModeGallery modes={[hybrid]} activeModeId="" onSelect={onSelect} />);
  await user.click(screen.getByRole("button", { name: /Map-to-Glyphscape/ }));
  expect(onSelect).toHaveBeenCalledWith(
    expect.objectContaining({
      mode_id: "builtin.map-glyphscape",
      seed: "hybrid-circuit-1",
      parameters: { theme: "city", geographic_fidelity: 75 },
    }),
  );
});
