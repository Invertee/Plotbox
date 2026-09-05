import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlotterSetup } from "./PlotterSetup";

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const settings = {
  schema_version: 1 as const,
  host: "fluidnc.local",
  port: 81,
  tls: false,
  command_timeout_seconds: 15,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Plotter Setup calibration test library", () => {
  it("lists and runs all named patterns without an application confirmation gate", async () => {
    const actionRequests: Record<string, unknown>[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (path === "/api/fluidnc/settings") return Promise.resolve(response(settings));
      if (path === "/api/fluidnc/actions") {
        actionRequests.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        return Promise.resolve(
          response({
            schema_version: 1,
            action: "commissioning_test",
            success: true,
            command_summary: ["registration", "42 commands"],
            response_lines: ["ok"],
            controller_state: "Idle",
            test_id: "registration",
          }),
        );
      }
      return Promise.reject(new Error(`unexpected request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PlotterSetup />);

    const testSelect = await screen.findByLabelText("Calibration test");
    expect(testSelect.querySelectorAll("option")).toHaveLength(11);
    expect(screen.getByRole("button", { name: "Run scale grid" })).toBeEnabled();

    await user.selectOptions(testSelect, "registration");
    expect(
      screen.getByText("Corner and centre crosshairs for repeatability and alignment checks."),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Run registration test" }));

    await waitFor(() => expect(actionRequests).toHaveLength(1));
    expect(actionRequests[0]).toMatchObject({
      action: "commissioning_test",
      test: { test_id: "registration" },
    });
  });

  it("clears a controller alarm without an application confirmation gate", async () => {
    const actionRequests: Record<string, unknown>[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (path === "/api/fluidnc/settings") return Promise.resolve(response(settings));
      if (path === "/api/fluidnc/actions") {
        actionRequests.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        return Promise.resolve(
          response({
            schema_version: 1,
            action: "alarm_reset",
            success: true,
            command_summary: ["$X (clear alarm / unlock)"],
            response_lines: ["ok"],
            controller_state: "Idle",
          }),
        );
      }
      return Promise.reject(new Error(`unexpected request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PlotterSetup />);

    const resetButton = await screen.findByRole("button", { name: "Reset FluidNC alarm" });
    await user.click(resetButton);

    await waitFor(() => expect(actionRequests).toHaveLength(1));
    expect(actionRequests[0]).toEqual({ action: "alarm_reset" });
  });

  it("sends the selected jog direction with the chosen speed", async () => {
    const actionRequests: Record<string, unknown>[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (path === "/api/fluidnc/settings") return Promise.resolve(response(settings));
      if (path === "/api/fluidnc/actions") {
        actionRequests.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        return Promise.resolve(
          response({
            schema_version: 1,
            action: "jog",
            success: true,
            command_summary: ["$J jog"],
            response_lines: ["ok"],
            controller_state: "Idle",
          }),
        );
      }
      return Promise.reject(new Error(`unexpected request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PlotterSetup />);

    await screen.findByLabelText("Jog feed");
    await user.click(screen.getByRole("button", { name: "Set jog speed to 1000 mm/min" }));
    await user.click(screen.getByRole("button", { name: "Jog X negative" }));

    await waitFor(() => expect(actionRequests).toHaveLength(1));
    expect(actionRequests[0]).toMatchObject({
      action: "jog",
      axis: "X",
      distance_mm: -5,
      feed_mm_min: 1000,
    });
  });

  it("homes XY separately from Z", async () => {
    const actionRequests: Record<string, unknown>[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (path === "/api/fluidnc/settings") return Promise.resolve(response(settings));
      if (path === "/api/fluidnc/actions") {
        const request = JSON.parse(init?.body as string) as Record<string, unknown>;
        actionRequests.push(request);
        return Promise.resolve(
          response({
            schema_version: 1,
            action: "home",
            success: true,
            command_summary: [request.axis === "XY" ? "$H=XY" : "$H=Z"],
            response_lines: ["ok"],
            controller_state: "Idle",
          }),
        );
      }
      return Promise.reject(new Error(`unexpected request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PlotterSetup />);

    await user.click(await screen.findByRole("button", { name: "Home X/Y" }));
    await waitFor(() => expect(actionRequests).toHaveLength(1));
    expect(actionRequests[0]).toEqual({ action: "home", axis: "XY" });

    await user.click(screen.getByRole("button", { name: "Home Z after pen install" }));
    await waitFor(() => expect(actionRequests).toHaveLength(2));
    expect(actionRequests[1]).toEqual({ action: "home", axis: "Z" });
  });

  it("shows the current machine coordinates after a status refresh", async () => {
    const actionRequests: Record<string, unknown>[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (path === "/api/fluidnc/settings") return Promise.resolve(response(settings));
      if (path === "/api/fluidnc/actions") {
        const request = JSON.parse(init?.body as string) as Record<string, unknown>;
        actionRequests.push(request);
        return Promise.resolve(
          response({
            schema_version: 1,
            action: "status",
            success: true,
            command_summary: ["?"],
            response_lines: ["<Idle|MPos:200.000,35.500,-2.250|FS:0,0>"],
            controller_state: "Idle",
          }),
        );
      }
      return Promise.reject(new Error(`unexpected request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PlotterSetup />);

    await user.click(await screen.findByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(actionRequests).toHaveLength(1));
    expect(actionRequests[0]).toEqual({ action: "status" });
    expect(screen.getByText("200.00")).toBeVisible();
    expect(screen.getByText("35.50")).toBeVisible();
    expect(screen.getByText("-2.25")).toBeVisible();
    expect(screen.getByText("Machine coordinates")).toBeVisible();
  });
});
