import { createApp } from "../src/app";

export type TestApp = ReturnType<typeof createApp>;

/**
 * Create a test app instance.
 * Does not start pollers or listen on a port.
 * Uses Elysia's `.handle()` method for testing without a real server.
 */
export function createTestApp(): TestApp {
  return createApp();
}

/**
 * Helper to make requests to the test app.
 * Uses Elysia's built-in request handling without needing a real server.
 */
export async function request(
  app: TestApp,
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<Response> {
  const { method = "GET", body, headers = {} } = options;

  const requestInit: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  };

  if (body !== undefined) {
    requestInit.body = JSON.stringify(body);
  }

  return app.handle(new Request(`http://localhost${path}`, requestInit));
}

/**
 * Parse JSON response with proper typing
 */
export async function parseJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

/**
 * Test fixtures
 * Note: sellToken is always CBBTC - not specified in API requests
 * Note: sellAmount is determined by the actual deposit, not specified in swap requests
 */
export const fixtures = {
  validSwapRequest: {
    chainId: 1,
    buyToken: { type: "erc20" as const, address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" }, // WETH
    recipientAddress: "0x1234567890123456789012345678901234567890",
    refundAddress: "0x1234567890123456789012345678901234567890",
  },

  validQuoteRequest: {
    chainId: 1,
    buyToken: { type: "erc20" as const, address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" }, // WETH
    sellAmount: "100000000", // 1 CBBTC (8 decimals)
  },

  invalidAddress: "0xinvalid",
  unsupportedChainId: 999,
} as const;
