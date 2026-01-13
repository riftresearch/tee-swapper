import { createPublicClient, http, type PublicClient } from "viem";
import { mainnet, base } from "viem/chains";
import { chains } from "../config/chains";
import {
  getPendingSwaps,
  markSwapExecuting,
  markSwapFailed,
  recordDeposit,
  saveOrderUid,
} from "../db/queries";
import { batchGetBalances } from "./multicall";
import { executeSwap as executeSwapFlow } from "./executor";
import { recordCowswapError } from "./metrics";
import type { Swap } from "../db/schema";
import type { ChainConfig } from "../types";

// Map chain IDs to viem chain configs
const viemChains = {
  1: mainnet,
  8453: base,
} as const;

// Store active poller intervals
const pollerIntervals: Map<number, ReturnType<typeof setInterval>> = new Map();

/**
 * Create a viem public client for a chain
 */
function createChainClient(config: ChainConfig): PublicClient {
  const chain = viemChains[config.chainId as keyof typeof viemChains];
  return createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  }) as PublicClient;
}

/**
 * Execute a swap after deposit is detected
 *
 * This submits the order to COWSwap and saves the order UID.
 * The settlement poller will track the order until it's filled.
 *
 * If COWSwap rejects the order (e.g., amount too small), the swap is marked
 * as failed and won't be retried. Funds remain in the vault for manual recovery.
 *
 * @param swap - The swap record
 * @param balance - The actual CBBTC balance in the vault to swap
 * @param client - Viem public client for the chain
 */
async function executeSwap(swap: Swap, balance: bigint, client: PublicClient): Promise<void> {
  console.log(`[Poller] Executing swap ${swap.swapId} on chain ${swap.chainId}, amount: ${balance}`);

  try {
    // Record the deposit amount
    await recordDeposit(swap.swapId, "", "", balance.toString());

    // Mark as executing
    await markSwapExecuting(swap.swapId);

    // Execute the swap using the permit flow with the actual balance
    const result = await executeSwapFlow(swap, balance, client);

    console.log(`[Poller] Swap ${swap.swapId} order submitted: ${result.orderId}`);

    // Save the order UID - settlement poller will track until filled
    await saveOrderUid(swap.swapId, result.orderId);

    console.log(
      `[Poller] Swap ${swap.swapId} order saved. ` +
        `Settlement poller will track until filled.`
    );
  } catch (error) {
    console.error(`[Poller] Swap ${swap.swapId} failed:`, error);

    // Extract error message for storage
    const failureReason = error instanceof Error ? error.message : String(error);

    // Record COWSwap error metric (most failures are from quote/order submission)
    recordCowswapError(swap.chainId, "createOrder");

    // Mark as failed - won't be retried. Funds remain in vault for manual recovery.
    await markSwapFailed(swap.swapId, failureReason);
  }
}

/**
 * Poll for pending swaps on a chain and execute funded ones
 *
 * Any non-zero balance triggers a swap attempt. If COWSwap rejects it
 * (e.g., amount too small), the swap is marked as failed.
 */
async function pollChain(config: ChainConfig, client: PublicClient): Promise<void> {
  try {
    // Get all pending swaps for this chain
    const pending = await getPendingSwaps(config.chainId);

    if (pending.length === 0) {
      return;
    }

    console.log(`[Poller] Chain ${config.chainId}: Checking ${pending.length} pending swaps`);

    // Batch get all balances
    const balances = await batchGetBalances(client, pending);

    // Process swaps that have any balance
    for (let i = 0; i < pending.length; i++) {
      const swap = pending[i];
      const balance = balances[i];

      if (!swap || balance === undefined) continue;

      if (balance > 0n) {
        console.log(`[Poller] Swap ${swap.swapId} has balance: ${balance}`);
        // Execute in background to not block other swaps
        // Pass the actual balance to swap the entire amount
        executeSwap(swap, balance, client).catch((err) =>
          console.error(`[Poller] Error executing swap ${swap.swapId}:`, err)
        );
      }
    }
  } catch (error) {
    console.error(`[Poller] Error polling chain ${config.chainId}:`, error);
  }
}

/**
 * Start the poller for a specific chain
 */
export function startPollerForChain(config: ChainConfig): void {
  console.log(
    `[Poller] Starting poller for ${config.name} (chain ${config.chainId}) ` +
    `with interval ${config.pollingIntervalMs}ms`
  );

  const client = createChainClient(config);

  // Run immediately once
  pollChain(config, client);

  // Then run on interval
  const interval = setInterval(() => {
    pollChain(config, client);
  }, config.pollingIntervalMs);

  pollerIntervals.set(config.chainId, interval);
}

/**
 * Stop the poller for a specific chain
 */
export function stopPollerForChain(chainId: number): void {
  const interval = pollerIntervals.get(chainId);
  if (interval) {
    clearInterval(interval);
    pollerIntervals.delete(chainId);
    console.log(`[Poller] Stopped poller for chain ${chainId}`);
  }
}

/**
 * Start pollers for all configured chains
 */
export function startAllPollers(): void {
  console.log("[Poller] Starting pollers for all chains");
  Object.values(chains).forEach(startPollerForChain);
}

/**
 * Stop all pollers
 */
export function stopAllPollers(): void {
  console.log("[Poller] Stopping all pollers");
  pollerIntervals.forEach((_, chainId) => stopPollerForChain(chainId));
}
