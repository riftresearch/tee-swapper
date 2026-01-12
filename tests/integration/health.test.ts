import { describe, it, expect, beforeAll } from "bun:test";
import { createTestApp, request, parseJson, type TestApp } from "../setup";

describe("Health Routes", () => {
  let app: TestApp;

  beforeAll(() => {
    app = createTestApp();
  });

  it("GET /health returns ok status", async () => {
    const response = await request(app, "/health");

    expect(response.status).toBe(200);

    const body = await parseJson<{ status: string; timestamp: number }>(response);

    expect(body.status).toBe("ok");
    expect(typeof body.timestamp).toBe("number");
    expect(body.timestamp).toBeGreaterThan(0);
  });
});
