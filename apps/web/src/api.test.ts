import { afterEach, describe, expect, it } from "vitest";

import { apiUrl } from "./api";

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("reverse-proxy API paths", () => {
  it("resolves from the site root during local development", () => {
    window.history.replaceState({}, "", "/");
    expect(apiUrl("api/health")).toBe("/api/health");
  });

  it("keeps Home Assistant's Ingress session prefix", () => {
    window.history.replaceState({}, "", "/api/hassio_ingress/session-token/");
    expect(apiUrl("api/health")).toBe("/api/hassio_ingress/session-token/api/health");
    expect(apiUrl("api/jobs/job-1/events")).toBe(
      "/api/hassio_ingress/session-token/api/jobs/job-1/events",
    );
  });
});
