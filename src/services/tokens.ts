import type { Swap } from "../db/schema";
import { isNativeToken, type SwapFlow } from "../types";
import { deserializeToken } from "../utils/token";

// Re-export from centralized constants for backward compatibility
export { GPV2_VAULT_RELAYER } from "../config/constants";

/**
 * Detect which execution flow to use for a swap
 *
 * Flow routing:
 * - Native ETH → EthFlow contract
 * - ERC-20 tokens → Try permit flow first, fall back to legacy if needed
 *
 * Note: Permit detection is done dynamically in the permit flow using
 * @cowprotocol/permit-utils. If the token doesn't support permits,
 * the permit flow will throw and we'll need to use the legacy flow.
 */
export function detectSwapFlow(swap: Swap): SwapFlow {
  const sellToken = deserializeToken(swap.sellToken);

  // Check native ETH first
  if (isNativeToken(sellToken)) {
    return { type: "native_eth" };
  }

  // For all ERC-20 tokens, try permit flow first
  // The permit flow will detect if the token supports permits
  // If not, it will throw and we should fall back to legacy
  return { type: "permit_erc20" };
}
