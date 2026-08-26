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
  it("lists all named patterns and requires the safety acknowledgement", async () => {
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
    expect(screen.getByRole("button", { name: "Run scale grid" })).toBeDisabled();

    await user.selectOptions(testSelect, "registration");
    expect(
      screen.getByText("Corner and centre crosshairs for repeatability and alignment checks."),
    ).toBeVisible();
    await user.click(
      screen.getByLabelText(
        "I have cleared this test area, verified the origin and Z values, and can stop the machine.",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Run registration test" }));

    await waitFor(() => expect(actionRequests).toHaveLength(1));
    expect(actionRequests[0]).toMatchObject({
      action: "commissioning_test",
      confirmed: true,
      test: { test_id: "registration", confirmed: true },
    });
    expect(
      screen.getByLabelText(
        "I have cleared this test area, verified the origin and Z values, and can stop the machine.",
      ),
    ).not.toBeChecked();
  });
});
