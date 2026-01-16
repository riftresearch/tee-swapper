/**
 * Swapper API Client
 * Single-file, zero-dependency TypeScript client for the TEE Swapper API
 */

// ============================================================================
// Types
// ============================================================================

export type SupportedChainId = 1 | 8453;

export type TokenAddress = `0x${string}`;

export type Token =
  | { type: "erc20"; address: TokenAddress }
  | { type: "ether" };

export type SwapStatus =
  | "pending_deposit"
  | "executing"
  | "complete"
  | "failed"
  | "expired"
  | "refund_pending"
  | "refunded";

// ============================================================================
// Request Types
// ============================================================================

export interface QuoteRequest {
  chainId: SupportedChainId;
  buyToken: Token;
  sellAmount: string;
}

export interface CreateSwapRequest {
  chainId: SupportedChainId;
  buyToken: Token;
  recipientAddress: TokenAddress;
  refundAddress: TokenAddress;
}

// ============================================================================
// Response Types
// ============================================================================

export interface HealthResponse {
  status: "ok";
  timestamp: number;
}

export interface QuoteResponse {
  quoteId: string;
  chainId: SupportedChainId;
  buyToken: Token;
  sellAmount: string;
  buyAmountEstimate: string;
  expiresAt: number;
  canFill: boolean;
}

export interface QuoteErrorResponse {
  error: string;
  canFill: false;
}

export interface CreateSwapResponse {
  swapId: string;
  vaultAddress: TokenAddress;
  chainId: SupportedChainId;
  buyToken: Token;
  recipientAddress: TokenAddress;
  refundAddress: TokenAddress;
  expiresAt: number;
  status: SwapStatus;
}

export interface SwapStatusResponse {
  swapId: string;
  chainId: SupportedChainId;
  vaultAddress: TokenAddress;
  buyToken: Token;
  recipientAddress: TokenAddress;
  refundAddress: TokenAddress;
  status: SwapStatus;
  createdAt: number;
  expiresAt: number;
  depositTxHash?: string;
  depositAmount?: string;
  settlementTxHash?: string;
  actualBuyAmount?: string;
  failureReason?: string;
  refundTxHash?: string;
  refundAmount?: string;
}

export interface ErrorResponse {
  error: string;
}

// ============================================================================
// Client Error
// ============================================================================

export class SwapperClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = "SwapperClientError";
  }
}

// ============================================================================
// Client Options
// ============================================================================

export interface SwapperClientOptions {
  /** Base URL of the swapper API (e.g., "https://swapper.example.com") */
  baseUrl: string;
  /** Optional fetch implementation (defaults to global fetch) */
  fetch?: typeof fetch;
  /** Optional headers to include with every request */
  headers?: Record<string, string>;
}

// ============================================================================
// Client Implementation
// ============================================================================

export class SwapperClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(options: SwapperClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.headers = options.headers ?? {};
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      ...this.headers,
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await this.fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const contentType = response.headers.get("content-type");
    const isJson = contentType?.includes("application/json");

    if (!response.ok) {
      const errorBody = isJson ? await response.json() : await response.text();
      throw new SwapperClientError(
        `Request failed: ${response.status} ${response.statusText}`,
        response.status,
        errorBody
      );
    }

    if (!isJson) {
      throw new SwapperClientError(
        `Expected JSON response but got ${contentType}`,
        response.status
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Check API health status
   */
  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health");
  }

  /**
   * Get a quote for swapping CBBTC to another token
   *
   * @param request - Quote parameters
   * @returns Quote with estimated output amount, or error if quote unavailable
   */
  async quote(
    request: QuoteRequest
  ): Promise<QuoteResponse | QuoteErrorResponse> {
    try {
      return await this.request<QuoteResponse>("POST", "/quote", request);
    } catch (error) {
      if (error instanceof SwapperClientError && error.status === 400) {
        return error.body as QuoteErrorResponse;
      }
      throw error;
    }
  }

  /**
   * Create a new swap
   *
   * @param request - Swap parameters including chain, token, and addresses
   * @returns Swap details including the vault address to deposit CBBTC to
   */
  async createSwap(request: CreateSwapRequest): Promise<CreateSwapResponse> {
    return this.request<CreateSwapResponse>("POST", "/swap", request);
  }

  /**
   * Get the current status of a swap
   *
   * @param swapId - The swap ID returned from createSwap
   * @returns Current swap status and details
   * @throws SwapperClientError with status 404 if swap not found
   */
  async getSwapStatus(swapId: string): Promise<SwapStatusResponse> {
    return this.request<SwapStatusResponse>("GET", `/swap/${swapId}`);
  }

  /**
   * Poll for swap completion
   *
   * @param swapId - The swap ID to poll
   * @param options - Polling options
   * @returns Final swap status when complete, failed, expired, or refunded
   */
  async waitForSwap(
    swapId: string,
    options: {
      /** Polling interval in milliseconds (default: 5000) */
      intervalMs?: number;
      /** Maximum time to wait in milliseconds (default: 600000 / 10 minutes) */
      timeoutMs?: number;
      /** Callback on each poll */
      onPoll?: (status: SwapStatusResponse) => void;
    } = {}
  ): Promise<SwapStatusResponse> {
    const { intervalMs = 5000, timeoutMs = 600000, onPoll } = options;
    const terminalStatuses: SwapStatus[] = [
      "complete",
      "failed",
      "expired",
      "refunded",
    ];

    const startTime = Date.now();

    while (true) {
      const status = await this.getSwapStatus(swapId);
      onPoll?.(status);

      if (terminalStatuses.includes(status.status)) {
        return status;
      }

      if (Date.now() - startTime > timeoutMs) {
        throw new SwapperClientError(
          `Timeout waiting for swap ${swapId} to complete`,
          408,
          status
        );
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new SwapperClient instance
 *
 * @example
 * ```ts
 * const client = createSwapperClient({ baseUrl: "https://swapper.example.com" });
 *
 * // Get a quote
 * const quote = await client.quote({
 *   chainId: 1,
 *   buyToken: { type: "erc20", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
 *   sellAmount: "100000000"
 * });
 *
 * // Create a swap
 * const swap = await client.createSwap({
 *   chainId: 1,
 *   buyToken: { type: "erc20", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
 *   recipientAddress: "0x1234567890123456789012345678901234567890",
 *   refundAddress: "0x1234567890123456789012345678901234567890"
 * });
 *
 * // Deposit CBBTC to swap.vaultAddress...
 *
 * // Wait for completion
 * const result = await client.waitForSwap(swap.swapId, {
 *   onPoll: (status) => console.log(`Status: ${status.status}`)
 * });
 * ```
 */
export function createSwapperClient(
  options: SwapperClientOptions
): SwapperClient {
  return new SwapperClient(options);
}

// Default export
export default SwapperClient;
