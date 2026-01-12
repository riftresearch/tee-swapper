import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createTestApp, request, parseJson, fixtures, type TestApp } from "../setup";
import { setupTestDatabase, teardownTestDatabase, cleanupSwaps } from "../db";
import type { CreateSwapResponse, SwapStatusResponse } from "../../src/types";

describe("Swap Routes", () => {
  let app: TestApp;

  beforeAll(async () => {
    // Set up in-memory PostgreSQL via PGlite
    await setupTestDatabase();
    app = createTestApp();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    // Clean up between tests for isolation
    await cleanupSwaps();
  });

  describe("POST /swap - Validation", () => {
    it("rejects unsupported chain ID", async () => {
      const response = await request(app, "/swap", {
        method: "POST",
        body: {
          ...fixtures.validSwapRequest,
          chainId: fixtures.unsupportedChainId,
        },
      });

      expect(response.status).toBe(400);

      const body = await parseJson<{ error: string }>(response);
      expect(body.error).toContain("Unsupported chain ID");
    });

    it("rejects invalid recipient address", async () => {
      const response = await request(app, "/swap", {
        method: "POST",
        body: {
          ...fixtures.validSwapRequest,
          recipientAddress: fixtures.invalidAddress,
        },
      });

      expect(response.status).toBe(400);

      const body = await parseJson<{ error: string }>(response);
      expect(body.error).toContain("Invalid recipient address");
    });

    it("rejects invalid refund address", async () => {
      const response = await request(app, "/swap", {
        method: "POST",
        body: {
          ...fixtures.validSwapRequest,
          refundAddress: fixtures.invalidAddress,
        },
      });

      expect(response.status).toBe(400);

      const body = await parseJson<{ error: string }>(response);
      expect(body.error).toContain("Invalid refund address");
    });

    it("rejects request with missing fields", async () => {
      const response = await request(app, "/swap", {
        method: "POST",
        body: {
          chainId: 1,
          sellToken: fixtures.validSwapRequest.sellToken,
          // missing other fields
        },
      });

      expect(response.status).toBe(422); // Elysia validation error
    });
  });

  describe("POST /swap - Database", () => {
    it("creates a swap with valid request", async () => {
      const response = await request(app, "/swap", {
        method: "POST",
        body: fixtures.validSwapRequest,
      });

      expect(response.status).toBe(200);

      const body = await parseJson<CreateSwapResponse>(response);

      expect(body.swapId).toBeDefined();
      expect(body.depositAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(body.chainId).toBe(fixtures.validSwapRequest.chainId);
      expect(body.sellToken).toEqual(fixtures.validSwapRequest.sellToken);
      expect(body.buyToken).toEqual(fixtures.validSwapRequest.buyToken);
      expect(body.expectedAmount).toBe(fixtures.validSwapRequest.sellAmount);
      expect(body.recipientAddress).toBe(fixtures.validSwapRequest.recipientAddress);
      expect(body.refundAddress).toBe(fixtures.validSwapRequest.refundAddress);
      expect(body.status).toBe("pending_deposit");
      expect(body.expiresAt).toBeGreaterThan(Date.now());
    });

    it("creates unique deposit addresses for each swap", async () => {
      const response1 = await request(app, "/swap", {
        method: "POST",
        body: fixtures.validSwapRequest,
      });
      const response2 = await request(app, "/swap", {
        method: "POST",
        body: fixtures.validSwapRequest,
      });

      const body1 = await parseJson<CreateSwapResponse>(response1);
      const body2 = await parseJson<CreateSwapResponse>(response2);

      expect(body1.depositAddress).not.toBe(body2.depositAddress);
      expect(body1.swapId).not.toBe(body2.swapId);
    });
  });

  describe("GET /swap/:id", () => {
    it("returns swap status for existing swap", async () => {
      // First create a swap
      const createResponse = await request(app, "/swap", {
        method: "POST",
        body: fixtures.validSwapRequest,
      });

      const createBody = await parseJson<CreateSwapResponse>(createResponse);
      const swapId = createBody.swapId;

      // Then fetch it
      const response = await request(app, `/swap/${swapId}`);

      expect(response.status).toBe(200);

      const body = await parseJson<SwapStatusResponse>(response);

      expect(body.swapId).toBe(swapId);
      expect(body.chainId).toBe(fixtures.validSwapRequest.chainId);
      expect(body.depositAddress).toBe(createBody.depositAddress);
      expect(body.status).toBe("pending_deposit");
      expect(body.createdAt).toBeDefined();
      expect(body.expiresAt).toBeDefined();
    });

    it("returns 404 for non-existent swap", async () => {
      const response = await request(app, "/swap/non-existent-id-12345");

      expect(response.status).toBe(404);

      const body = await parseJson<{ error: string }>(response);
      expect(body.error).toBe("Swap not found");
    });
  });
});
