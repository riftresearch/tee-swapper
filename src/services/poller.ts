import { createPublicClient, http, type PublicClient } from "viem";
import { mainnet, base } from "viem/chains";
import { chains } from "../config/chains";
import {
  getPendingSwaps,
  markSwapExecuting,
  markSwapFailedNeedsRefund,
  saveOrderUid,
} from "../db/queries";
import { batchGetBalances } from "./multicall";
import { executeSwap as executeSwapFlow } from "./executor";
import { UnsupportedTokenError } from "./flows/legacy";
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
 */
async function executeSwap(swap: Swap, client: PublicClient): Promise<void> {
  console.log(`[Poller] Executing swap ${swap.swapId} on chain ${swap.chainId}`);

  try {
    // Mark as executing
    await markSwapExecuting(swap.swapId);

    // Execute the swap using the appropriate flow (ETH, permit, or legacy)
    const result = await executeSwapFlow(swap, client);

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
    let failureReason: string;
    if (error instanceof UnsupportedTokenError) {
      failureReason = `Token requires hot wallet flow (not implemented): ${swap.sellToken}`;
    } else if (error instanceof Error) {
      failureReason = error.message;
    } else {
      failureReason = String(error);
    }

    // Since we got here after detecting a deposit, funds need to be refunded
    await markSwapFailedNeedsRefund(swap.swapId, failureReason);
  }
}

/**
 * Poll for pending swaps on a chain and execute funded ones
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

    // Process swaps that have sufficient balance
    for (let i = 0; i < pending.length; i++) {
      const swap = pending[i];
      const balance = balances[i];
      
      if (!swap || balance === undefined) continue;
      
      const expectedAmount = BigInt(swap.expectedAmount);

      if (balance >= expectedAmount) {
        console.log(
          `[Poller] Swap ${swap.swapId} funded: ${balance} >= ${expectedAmount}`
        );
        // Execute in background to not block other swaps
        executeSwap(swap, client).catch((err) =>
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
