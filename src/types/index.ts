// Supported chain IDs
export type SupportedChainId = 1 | 8453;

// Token address type for ERC20 tokens
export type TokenAddress = `0x${string}`;

/**
 * Token specification - tagged union for type safety
 */
export type Token =
  | { type: "native" }
  | { type: "erc20"; address: TokenAddress };

/**
 * Type guard for native ETH token
 */
export function isNativeToken(token: Token): token is { type: "native" } {
  return token.type === "native";
}

/**
 * Type guard for ERC20 token
 */
export function isErc20Token(token: Token): token is { type: "erc20"; address: TokenAddress } {
  return token.type === "erc20";
}

/**
 * Get the address from an ERC20 token, throws if native
 */
export function getTokenAddress(token: Token): TokenAddress {
  if (isNativeToken(token)) {
    throw new Error("Cannot get address of native token");
  }
  return token.address;
}

// Swap status enum
export type SwapStatus =
  | "pending_deposit"
  | "executing"
  | "complete"
  | "failed"
  | "expired"
  | "refund_pending"
  | "refunded";

// Chain configuration
export interface ChainConfig {
  chainId: SupportedChainId;
  name: string;
  rpcUrl: string;
  multicall3: `0x${string}`;
  pollingIntervalMs: number;
  swapTtlMs: number;
}

// API Request/Response types
export interface QuoteRequest {
  chainId: SupportedChainId;
  sellToken: Token;
  buyToken: Token;
  sellAmount: string;
}

export interface QuoteResponse {
  quoteId: string;
  chainId: SupportedChainId;
  sellToken: Token;
  buyToken: Token;
  sellAmount: string;
  buyAmountEstimate: string;
  expiresAt: number;
  canFill: boolean;
}

export interface CreateSwapRequest {
  chainId: SupportedChainId;
  sellToken: Token;
  buyToken: Token;
  sellAmount: string;
  recipientAddress: `0x${string}`;
  refundAddress: `0x${string}`;
}

export interface CreateSwapResponse {
  swapId: string;
  depositAddress: `0x${string}`;
  chainId: SupportedChainId;
  sellToken: Token;
  buyToken: Token;
  expectedAmount: string;
  recipientAddress: `0x${string}`;
  refundAddress: `0x${string}`;
  expiresAt: number;
  status: SwapStatus;
}

export interface SwapStatusResponse {
  swapId: string;
  chainId: SupportedChainId;
  depositAddress: `0x${string}`;
  sellToken: Token;
  buyToken: Token;
  expectedAmount: string;
  recipientAddress: `0x${string}`;
  refundAddress: `0x${string}`;
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

// COWSwap order statuses
export type CowOrderStatus =
  | "PRESIGNATURE_PENDING"  // Waiting for on-chain presign
  | "OPEN"                  // Active, waiting for solver
  | "FULFILLED"             // Completely filled
  | "CANCELLED"             // Cancelled by user
  | "EXPIRED";              // validTo passed without fill

// Execution result from flow handlers
export interface ExecutionResult {
  orderId: string;   // COWSwap order UID (56 bytes hex)
  buyAmount: string;
}

// Discriminated union for swap execution flows
// Note: Permit detection is done dynamically in the permit flow
// using @cowprotocol/permit-utils, not via static config
export type SwapFlow =
  | { type: "native_eth" }
  | { type: "permit_erc20" }
  | { type: "legacy_erc20" };
