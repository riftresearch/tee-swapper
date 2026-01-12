import type { Swap } from "../../db/schema";
import type { ExecutionResult } from "../../types";

/**
 * Error thrown when a swap requires the legacy (hot wallet) flow
 * which is not yet implemented
 */
export class UnsupportedTokenError extends Error {
  constructor(
    public readonly swap: Swap,
    message = "Token does not support permits and hot wallet flow is not yet implemented"
  ) {
    super(message);
    this.name = "UnsupportedTokenError";
  }
}

/**
 * Execute a swap for a legacy ERC-20 token (no permit support)
 *
 * This flow requires a hot wallet to:
 * 1. Fund the deposit address with ETH for gas
 * 2. Send an approve() transaction to the GPv2VaultRelayer
 * 3. Submit the COWSwap order
 *
 * Currently stubbed - throws UnsupportedTokenError
 */
export async function executeLegacyFlow(swap: Swap): Promise<ExecutionResult> {
  throw new UnsupportedTokenError(swap);
}
