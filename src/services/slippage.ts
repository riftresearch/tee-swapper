/**
 * Slippage Tolerance Service
 *
 * Fetches recommended slippage from COWSwap's BFF API and caches results
 * with a 30-second TTL to avoid excessive API calls.
 */

import type { SupportedChainId, TokenAddress } from "../types";

// COWSwap BFF API base URL
const COW_BFF_BASE_URL = "https://bff.cow.fi";

// Cache TTL in milliseconds (30 seconds)
const CACHE_TTL_MS = 30_000;

// Default slippage if API fails (50 bps = 0.5%)
const DEFAULT_SLIPPAGE_BPS = 50;

interface CacheEntry {
  slippageBps: number;
  timestamp: number;
}

interface SlippageResponse {
  slippageBps: number;
}

// In-memory cache keyed by "chainId-sellToken-buyToken"
const slippageCache = new Map<string, CacheEntry>();

/**
 * Build cache key from market parameters
 */
function getCacheKey(
  chainId: SupportedChainId,
  sellToken: TokenAddress,
  buyToken: TokenAddress
): string {
  return `${chainId}-${sellToken.toLowerCase()}-${buyToken.toLowerCase()}`;
}

/**
 * Check if a cache entry is still valid
 */
function isCacheValid(entry: CacheEntry): boolean {
  return Date.now() - entry.timestamp < CACHE_TTL_MS;
}

/**
 * Fetch slippage tolerance from COWSwap BFF API
 */
async function fetchSlippageTolerance(
  chainId: SupportedChainId,
  sellToken: TokenAddress,
  buyToken: TokenAddress
): Promise<number> {
  const url = `${COW_BFF_BASE_URL}/${chainId}/markets/${sellToken}-${buyToken}/slippageTolerance`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      console.warn(
        `[Slippage] API returned ${response.status} for ${sellToken}-${buyToken} on chain ${chainId}`
      );
      return DEFAULT_SLIPPAGE_BPS;
    }

    const data = (await response.json()) as SlippageResponse;

    if (typeof data.slippageBps !== "number") {
      console.warn(`[Slippage] Invalid response format:`, data);
      return DEFAULT_SLIPPAGE_BPS;
    }

    console.log(
      `[Slippage] Fetched ${data.slippageBps} bps for ${sellToken}-${buyToken} on chain ${chainId}`
    );
    return data.slippageBps;
  } catch (error) {
    console.error(`[Slippage] Failed to fetch slippage tolerance:`, error);
    return DEFAULT_SLIPPAGE_BPS;
  }
}

/**
 * Get recommended slippage tolerance for a market
 *
 * Returns cached value if available and fresh (< 30s old),
 * otherwise fetches from COWSwap BFF API and caches the result.
 *
 * @param chainId - The chain ID
 * @param sellToken - The sell token address (always CBBTC for us)
 * @param buyToken - The buy token address
 * @returns Slippage tolerance in basis points (1 bps = 0.01%)
 */
export async function getSlippageTolerance(
  chainId: SupportedChainId,
  sellToken: TokenAddress,
  buyToken: TokenAddress
): Promise<number> {
  const cacheKey = getCacheKey(chainId, sellToken, buyToken);

  // Check cache first
  const cached = slippageCache.get(cacheKey);
  if (cached && isCacheValid(cached)) {
    console.log(`[Slippage] Using cached value: ${cached.slippageBps} bps`);
    return cached.slippageBps;
  }

  // Fetch fresh value
  const slippageBps = await fetchSlippageTolerance(chainId, sellToken, buyToken);

  // Cache the result
  slippageCache.set(cacheKey, {
    slippageBps,
    timestamp: Date.now(),
  });

  return slippageBps;
}

/**
 * Apply slippage to a buy amount for a sell order
 *
 * For sell orders, we reduce the minimum buy amount by the slippage tolerance
 * to account for price movement.
 *
 * @param buyAmount - The quoted buy amount
 * @param slippageBps - Slippage tolerance in basis points
 * @returns The minimum acceptable buy amount after slippage
 */
export function applySlippageToBuyAmount(
  buyAmount: string,
  slippageBps: number
): string {
  const amount = BigInt(buyAmount);
  // buyAmountMin = buyAmount * (10000 - slippageBps) / 10000
  const slippageMultiplier = BigInt(10000 - slippageBps);
  const minAmount = (amount * slippageMultiplier) / BigInt(10000);
  return minAmount.toString();
}

/**
 * Clear the slippage cache (useful for testing)
 */
export function clearSlippageCache(): void {
  slippageCache.clear();
}
