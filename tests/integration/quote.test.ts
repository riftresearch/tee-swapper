import { describe, it, expect, beforeAll } from "bun:test";
import { createTestApp, request, parseJson, fixtures, type TestApp } from "../setup";
import type { QuoteResponse } from "../../src/types";

describe("Quote Routes", () => {
  let app: TestApp;

  beforeAll(() => {
    app = createTestApp();
  });

  describe("POST /quote", () => {
    it("rejects unsupported chain ID", async () => {
      const response = await request(app, "/quote", {
        method: "POST",
        body: {
          ...fixtures.validQuoteRequest,
          chainId: fixtures.unsupportedChainId,
        },
      });

      expect(response.status).toBe(400);

      const body = await parseJson<{ error: string }>(response);
      expect(body.error).toContain("Unsupported chain ID");
    });

    it("rejects request with missing fields", async () => {
      const response = await request(app, "/quote", {
        method: "POST",
        body: {
          chainId: 1,
          // missing other fields
        },
      });

      expect(response.status).toBe(422); // Elysia validation error
    });

    // NOTE: This test hits the real COWSwap API
    // Mark as slow/integration and skip in CI unless configured
    it.skip("gets a quote from COWSwap API", async () => {
      const response = await request(app, "/quote", {
        method: "POST",
        body: fixtures.validQuoteRequest,
      });

      expect(response.status).toBe(200);

      const body = await parseJson<QuoteResponse>(response);

      expect(body.quoteId).toBeDefined();
      expect(body.chainId).toBe(fixtures.validQuoteRequest.chainId);
      expect(body.buyToken).toEqual(fixtures.validQuoteRequest.buyToken);
      expect(body.sellAmount).toBeDefined();
      expect(body.buyAmountEstimate).toBeDefined();
      expect(body.expiresAt).toBeGreaterThan(Date.now());
      expect(body.canFill).toBe(true);
    });
  });
});
