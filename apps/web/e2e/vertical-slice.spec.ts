/// <reference lib="dom" />

import { expect, test } from "@playwright/test";
import path from "node:path";

test("A3 design exports and reopens with identical hashes", async ({ page }) => {
  await page.goto("/");
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("connection-state")).toContainText("ready");
  }).toPass({ timeout: 15_000 });
  await page.getByRole("button", { name: "Create A3 project" }).click();
  await expect(page.getByRole("heading", { name: "Pen passes" })).toBeVisible();
  const workspaceOverflow = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".workspace-active");
    const workspace = document.querySelector<HTMLElement>(".workspace");
    const controls = document.querySelector<HTMLElement>(".controls-panel");
    const passes = document.querySelector<HTMLElement>(".passes-panel");
    const viewer = document.querySelector<HTMLElement>(".viewer-column");
    if (!shell || !workspace || !controls || !passes || !viewer) {
      throw new Error("Workspace shell is incomplete");
    }
    return {
      shellHeight: shell.getBoundingClientRect().height,
      viewportHeight: window.innerHeight,
      documentOverflow: getComputedStyle(document.documentElement).overflow,
      bodyOverflow: getComputedStyle(document.body).overflow,
      rootOverflow: getComputedStyle(document.querySelector<HTMLElement>("#root")!).overflow,
      shellOverflow: getComputedStyle(shell).overflow,
      workspaceOverflow: getComputedStyle(workspace).overflow,
      controlsOverflowY: getComputedStyle(controls).overflowY,
      passesOverflowY: getComputedStyle(passes).overflowY,
      viewerOverflow: getComputedStyle(viewer).overflow,
    };
  });
  expect(workspaceOverflow).toEqual({
    shellHeight: workspaceOverflow.viewportHeight,
    viewportHeight: workspaceOverflow.viewportHeight,
    documentOverflow: "hidden",
    bodyOverflow: "hidden",
    rootOverflow: "hidden",
    shellOverflow: "hidden",
    workspaceOverflow: "hidden",
    controlsOverflowY: "auto",
    passesOverflowY: "auto",
    viewerOverflow: "hidden",
  });
  await page.getByLabel("Deterministic seed").fill("codex-vertical-slice-1");
  await page.getByRole("button", { name: "Generate design" }).click();
  await expect(page.getByTestId("design-hash")).not.toHaveText("—");
  await page.getByRole("button", { name: "Toolpath + travel" }).click();
  await expect(page.getByText("PlotPlan", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Export validated bundle" }).click();
  await expect(page.getByTestId("export-result")).toContainText("Round trip verified");
  await expect(page.getByTestId("export-result")).toContainText("combined.nc");
  await expect(page.getByTestId("export-result")).toContainText("dry-run.nc");
  await expect(page.getByTestId("export-result")).toContainText("page-boundary.nc");
  const designHash = await page.getByTestId("design-hash").textContent();
  const planHash = await page.getByTestId("plan-hash").textContent();
  const manifestHash = await page.getByTestId("manifest-hash").textContent();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download .zip" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("plotbox-a3-gcode.zip");

  await page.getByRole("button", { name: "Save project" }).click();
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(page.getByTestId("design-hash")).toHaveText(designHash ?? "");
  await expect(page.getByTestId("plan-hash")).toHaveText(planHash ?? "");
  await page.getByRole("button", { name: "Export validated bundle" }).click();
  await expect(page.getByTestId("manifest-hash")).toHaveText(manifestHash ?? "");
});

test("an undersized export work area is a blocking error", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create A3 project" }).click();
  await page.getByRole("button", { name: "Generate design" }).click();
  await expect(page.getByRole("region", { name: "Plot plan summary" })).toContainText(
    "Plot plan ready",
  );
  await page.getByLabel("Work width").fill("300");
  await expect(page.getByLabel("Work width")).toHaveValue("300");
  await page.getByRole("button", { name: "Export validated bundle" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "does not fit inside the configured export work area",
  );
});

test("SVG imports with warnings, replans passes, and exports SVG files", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create A3 project" }).click();
  await page.getByRole("button", { name: "Image import" }).click();
  await page
    .getByLabel("Choose source file")
    .setInputFiles(path.resolve("../../fixtures/svg/two-layer-transforms.svg"));
  await expect(page.getByText("two-layer-transforms.svg")).toBeVisible();
  await page.getByLabel("Fill treatment").selectOption("hatch");
  await page.getByLabel("Generation quality").selectOption("standard");
  await page.getByRole("button", { name: "Convert SVG" }).click();
  await expect(page.getByTestId("design-hash")).not.toHaveText("—");
  await expect(page.getByRole("region", { name: "SVG import warnings" })).toContainText(
    "not imported",
  );
  await expect(page.getByLabel("structure pen name")).toHaveValue("Black");
  await page.getByRole("button", { name: "Move Cyan earlier" }).click();
  await page.getByRole("button", { name: "Apply pass changes" }).click();
  await expect(page.getByRole("button", { name: "Toolpath + travel" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export SVG pass bundle" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("plotbox-svg-passes.zip");
});

test("PNG is preprocessed, vectorized, planned, and reopened", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create A3 project" }).click();
  await page.getByRole("button", { name: "Image import" }).click();
  await page.getByLabel("Choose source file").setInputFiles({
    name: "line-art.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAAAAAC+OKDoAAAAS0lEQVR4nLWRwQkAIAwDr8XBHN3NKqg/qQqt+eZIIBHjLCUKFEBc17IqGFmbZnO8Qv8DYiDVMZu9JuDtkDK13oD1hf94zlCxhCvQAdJBCjDYg6kwAAAAAElFTkSuQmCC",
      "base64",
    ),
  });
  await expect(page.getByRole("group", { name: "Raster preprocessing" })).toBeVisible();
  await page.getByLabel("Raster rotation").selectOption("90");
  await page.getByLabel("Raster grayscale channel").selectOption("red");
  await page.getByLabel("Raster threshold mode").selectOption("adaptive");
  await page.getByLabel("Generation quality").selectOption("draft");
  await page.getByRole("button", { name: "Preview raster preprocessing" }).click();
  await expect(page.getByText("Raster preprocessing", { exact: true })).toBeVisible();
  await expect(page.getByTestId("raster-preview-stats")).toContainText("mm/px", {
    timeout: 15_000,
  });
  await page.getByLabel("Raster vectorization algorithm").selectOption("edge");
  await page.getByRole("button", { name: "Vectorize and plan" }).click();
  await expect(page.getByTestId("design-hash")).not.toHaveText("—", {
    timeout: 15_000,
  });
  await expect(page.getByRole("region", { name: "Plot plan summary" })).toContainText(
    "Plot plan ready",
  );
  await expect(page.getByRole("button", { name: "Toolpath + travel" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText("PlotPlan", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Raster vectorization warnings" })).toContainText(
    "emitted",
  );

  await page.getByRole("button", { name: "Save project" }).click();
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(page.getByTestId("raster-preview-stats")).toContainText("mm/px", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("design-hash")).not.toHaveText("—", {
    timeout: 15_000,
  });
});

test("two-color poster maps source roles to pens and previews overprint", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create A3 project" }).click();
  await page.getByRole("button", { name: "Image import" }).click();
  await page
    .getByLabel("Choose source file")
    .setInputFiles(path.resolve("../../fixtures/raster/two-color-poster.png"));
  await page.getByLabel("Raster vectorization algorithm").selectOption("color-outline");
  await page.getByLabel("Raster source color count").fill("2");
  await page.getByLabel("Generation quality").selectOption("draft");
  await expect(page.getByLabel("Generation quality")).toHaveValue("draft");
  await page.getByRole("button", { name: "Vectorize and plan" }).click();
  await expect(page.getByTestId("design-hash")).not.toHaveText("—", {
    timeout: 15_000,
  });
  await expect(page.locator(".pass-card")).toHaveCount(2);
  await expect(page.locator(".pass-card").first()).toContainText("source-color-");

  await page
    .locator(".pass-card")
    .nth(0)
    .getByRole("combobox", { name: /physical pen/i })
    .selectOption("black-05");
  await page
    .locator(".pass-card")
    .nth(1)
    .getByRole("combobox", { name: /physical pen/i })
    .selectOption("cyan-05");
  await page.getByLabel("Preview physical pen overprint").check();
  await page.getByLabel("Show raster source overlay").uncheck();
  await page.getByRole("button", { name: "Design", exact: true }).click();
  await page.getByRole("button", { name: "Apply pass changes" }).click();
  await page.getByRole("button", { name: "Export validated bundle" }).click();
  await expect(page.getByTestId("export-result")).toContainText("Round trip verified");

  const designHash = await page.getByTestId("design-hash").textContent();
  await page.getByRole("button", { name: "Save project" }).click();
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(page.getByLabel("Raster vectorization algorithm")).toHaveValue("color-outline");
  await expect(page.locator(".pass-card")).toHaveCount(2);
  await expect(page.getByTestId("design-hash")).toHaveText(designHash ?? "");
});

test("procedural gallery selects, presets, regenerates, and plans a mode", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create A3 project" }).click();
  await page.getByRole("button", { name: /Flow Field/ }).click();
  await expect(page.getByLabel("Vector field")).toHaveValue("curl");
  await expect(page.getByLabel("Flow Field preset")).toHaveValue("");
  const firstSeed = await page.getByLabel("Deterministic seed").inputValue();
  await page.getByRole("button", { name: "Regenerate seed" }).click();
  await expect(page.getByLabel("Deterministic seed")).not.toHaveValue(firstSeed);
  await page.getByRole("button", { name: "Generate design" }).click();
  await expect(page.getByTestId("design-hash")).not.toHaveText("—");
  await expect(page.getByRole("region", { name: "Plot plan summary" })).toContainText(
    "Plot plan ready",
  );
});

test("project list manages names and returns from the editor", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Project name").fill("Lifecycle test project");
  await page.getByRole("button", { name: "Create A3 project" }).click();
  await expect(page.getByRole("heading", { name: "Pen passes" })).toBeVisible();
  await page.getByRole("button", { name: "Projects" }).click();

  const projectCard = page.locator(".project-card").filter({ hasText: "Lifecycle test project" });
  await projectCard.getByRole("button", { name: "Rename" }).click();
  await projectCard.getByLabel("Rename project").fill("Managed lifecycle project");
  await projectCard.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("heading", { name: "Managed lifecycle project" })).toBeVisible();

  const renamedCard = page
    .locator(".project-card")
    .filter({ hasText: "Managed lifecycle project" });
  await renamedCard.getByRole("button", { name: "Open project" }).click();
  await expect(page.getByRole("heading", { name: "Pen passes" })).toBeVisible();
  await page.getByRole("button", { name: "Projects" }).click();
  await renamedCard.getByRole("button", { name: "Delete" }).click();
  await renamedCard.getByRole("button", { name: "Confirm delete" }).click();
  await expect(page.getByRole("heading", { name: "Managed lifecycle project" })).toHaveCount(0);
});

test("plotter setup exposes direct machine controls", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Plotter setup" }).click();
  await expect(page.getByLabel("FluidNC hostname")).toHaveValue("fluidnc.local");
  await expect(page.getByRole("button", { name: "Run guarded jog" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Start homing" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Run up → down → up test" })).toBeEnabled();
  await page.getByLabel("Measured calibration distance").fill("98");
  await page.getByRole("button", { name: "Calculate correction" }).click();
  await expect(page.getByText("81.632653")).toBeVisible();
});
