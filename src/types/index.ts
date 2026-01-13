// Supported chain IDs
export type SupportedChainId = 1 | 8453;

// Token address type for ERC20 tokens
export type TokenAddress = `0x${string}`;

// Native ETH sentinel address used by COWSwap
export const NATIVE_ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as TokenAddress;

/**
 * Token specification - supports ERC20 and native ETH
 *
 * For native ETH, use type: "ether" - the system will handle the sentinel address internally
 */
export type Token =
  | { type: "erc20"; address: TokenAddress }
  | { type: "ether" };  // Native ETH (uses sentinel address internally)

/**
 * Check if a token is native ETH
 */
export function isEtherToken(token: Token): token is { type: "ether" } {
  return token.type === "ether";
}

/**
 * Get the address to use for a token in COWSwap API
 * Returns the sentinel address for native ETH
 */
export function getTokenAddress(token: Token): TokenAddress {
  return isEtherToken(token) ? NATIVE_ETH_ADDRESS : token.address;
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
// Note: sellToken is always CBBTC - not specified in requests/responses

export interface QuoteRequest {
  chainId: SupportedChainId;
  buyToken: Token;
  sellAmount: string; // Amount of CBBTC to sell
}

export interface QuoteResponse {
  quoteId: string;
  chainId: SupportedChainId;
  buyToken: Token;
  sellAmount: string; // Amount of CBBTC
  buyAmountEstimate: string;
  expiresAt: number;
  canFill: boolean;
}

export interface CreateSwapRequest {
  chainId: SupportedChainId;
  buyToken: Token;
  recipientAddress: `0x${string}`;
  refundAddress: `0x${string}`;
}

export interface CreateSwapResponse {
  swapId: string;
  vaultAddress: `0x${string}`;
  chainId: SupportedChainId;
  buyToken: Token;
  recipientAddress: `0x${string}`;
  refundAddress: `0x${string}`;
  expiresAt: number;
  status: SwapStatus;
}

export interface SwapStatusResponse {
  swapId: string;
  chainId: SupportedChainId;
  vaultAddress: `0x${string}`;
  buyToken: Token;
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
