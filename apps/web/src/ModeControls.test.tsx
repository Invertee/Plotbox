import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { GeneratedModeControls } from "./ModeControls";
import type { ModeManifest, ProjectRecipe } from "./types";

const manifest: ModeManifest = {
  schema_version: 1,
  kind: "generator",
  id: "builtin.fixture",
  version: "2.0.0",
  name: "Fixture mode",
  description: "",
  category: "procedural",
  quality_levels: ["draft", "standard", "export"],
  semantic_roles: ["accent"],
  parameter_schema_version: 2,
  parameter_groups: [{ group_id: "main", label: "Main", description: "" }],
  parameters: [
    {
      key: "seed",
      label: "Seed",
      kind: "seed",
      group: "main",
      default: "alpha",
      description: "",
      unit: "",
      minimum: null,
      maximum: null,
      step: null,
      options: [],
    },
    {
      key: "density",
      label: "Density",
      kind: "number",
      group: "main",
      default: 1,
      description: "",
      unit: "",
      minimum: 0,
      maximum: 2,
      step: 0.1,
      options: [],
    },
    {
      key: "count",
      label: "Count",
      kind: "integer",
      group: "main",
      default: 2,
      description: "",
      unit: "",
      minimum: 1,
      maximum: 8,
      step: 1,
      options: [],
    },
    {
      key: "enabled",
      label: "Enabled",
      kind: "boolean",
      group: "main",
      default: true,
      description: "",
      unit: "",
      minimum: null,
      maximum: null,
      step: null,
      options: [],
    },
    {
      key: "family",
      label: "Family",
      kind: "enum",
      group: "main",
      default: "a",
      description: "",
      unit: "",
      minimum: null,
      maximum: null,
      step: null,
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    },
    {
      key: "color",
      label: "Color",
      kind: "color",
      group: "main",
      default: "#112233",
      description: "",
      unit: "",
      minimum: null,
      maximum: null,
      step: null,
      options: [],
    },
    {
      key: "role",
      label: "Role",
      kind: "role",
      group: "main",
      default: "accent",
      description: "",
      unit: "",
      minimum: null,
      maximum: null,
      step: null,
      options: [{ value: "accent", label: "Accent" }],
    },
    {
      key: "band",
      label: "Band",
      kind: "range",
      group: "main",
      default: [1, 3],
      description: "",
      unit: "mm",
      minimum: 0,
      maximum: 5,
      step: 1,
      options: [],
    },
  ],
  presets: [
    {
      schema_version: 1,
      preset_id: "dense",
      version: 1,
      mode_id: "builtin.fixture",
      mode_version: "2.0.0",
      name: "Dense",
      description: "",
      parameter_schema_version: 2,
      seed: "preset-seed",
      parameters: { density: 2, count: 8 },
    },
  ],
  algorithms: [],
  parameter_schema: null,
};

const settings: ProjectRecipe["mode"] = {
  mode_id: manifest.id,
  version: manifest.version,
  seed: "alpha",
  quality: "standard",
  parameter_schema_version: 2,
  parameters: {},
};

afterEach(cleanup);

it("renders common mode fields and emits typed changes", () => {
  const onChange = vi.fn<(settings: ProjectRecipe["mode"]) => void>();
  render(<GeneratedModeControls manifest={manifest} settings={settings} onChange={onChange} />);

  expect(screen.getByLabelText("Seed")).toHaveValue("alpha");
  expect(screen.getByLabelText("Density")).toHaveValue("1");
  expect(screen.getByLabelText("Count")).toHaveValue("2");
  expect(screen.getByLabelText("Enabled")).toBeChecked();
  expect(screen.getByLabelText("Family")).toHaveValue("a");
  expect(screen.getByLabelText("Color")).toHaveValue("#112233");
  expect(screen.getByLabelText("Role")).toHaveValue("accent");
  expect(screen.getByLabelText("Band minimum")).toHaveValue("1");
  expect(screen.getByLabelText("Band maximum")).toHaveValue("3");

  fireEvent.change(screen.getByRole("slider", { name: "Density" }), { target: { value: "1.5" } });
  expect(onChange.mock.lastCall?.[0].parameters.density).toBe(1.5);
});

it("applies versioned preset parameters and seed", async () => {
  const onChange = vi.fn<(settings: ProjectRecipe["mode"]) => void>();
  const user = userEvent.setup();
  render(<GeneratedModeControls manifest={manifest} settings={settings} onChange={onChange} />);

  await user.selectOptions(screen.getByLabelText("Fixture mode preset"), "dense");
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    seed: "preset-seed",
    parameter_schema_version: 2,
    parameters: { density: 2, count: 8 },
  });
});
