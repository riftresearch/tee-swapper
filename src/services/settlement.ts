import {
  getExecutingSwaps,
  updateCowOrderStatus,
  markExpiredSwaps,
  getSwapCountsByStatusAndChain,
} from "../db/queries";
import { getOrderStatus, getOrderTrades } from "./cowswap";
import {
  updateActiveSwapCounts,
  recordSwapCompleted,
  recordCowswapError,
} from "./metrics";
import type { SupportedChainId } from "../types";

// Poll every 30 seconds for order settlement
const SETTLEMENT_POLL_INTERVAL_MS = 30_000;

/**
 * Mark any expired swaps (pending_deposit past expiresAt)
 * Called each poll cycle for housekeeping
 */
async function processExpiredSwaps(): Promise<void> {
  const expiredCount = await markExpiredSwaps();
  if (expiredCount > 0) {
    console.log(`[Settlement] Marked ${expiredCount} swap(s) as expired`);
  }
}

/**
 * Update Prometheus metrics for active swap counts
 */
async function updateMetrics(): Promise<void> {
  try {
    const counts = await getSwapCountsByStatusAndChain();
    updateActiveSwapCounts(counts);
  } catch (error) {
    console.error("[Settlement] Error updating metrics:", error);
  }
}

// Store the poller interval
let settlementInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Poll all executing swaps for settlement status updates
 * Also handles housekeeping: marking expired swaps, updating metrics
 */
export async function pollSettlements(): Promise<void> {
  // Housekeeping: mark expired swaps and update metrics
  await processExpiredSwaps();
  await updateMetrics();

  const executingSwaps = await getExecutingSwaps();

  if (executingSwaps.length === 0) {
    return;
  }

  console.log(`[Settlement] Checking ${executingSwaps.length} executing swaps`);

  for (const swap of executingSwaps) {
    // Skip swaps without an order UID (shouldn't happen, but be safe)
    if (!swap.cowOrderUid) {
      console.log(`[Settlement] Swap ${swap.swapId} missing order UID, skipping`);
      continue;
    }

    try {
      const { status, executedBuyAmount } = await getOrderStatus(
        swap.chainId as SupportedChainId,
        swap.cowOrderUid
      );

      // Log when status changes, or periodically for OPEN orders (debugging)
      if (status !== swap.orderStatus) {
        console.log(
          `[Settlement] Swap ${swap.swapId} order status: ${swap.orderStatus} -> ${status}`
        );
      } else if (status === "OPEN") {
        console.log(`[Settlement] Swap ${swap.swapId} still OPEN, waiting for solver...`);
      }

      if (status === "FULFILLED") {
        // Get settlement transaction from trades
        const trades = await getOrderTrades(
          swap.chainId as SupportedChainId,
          swap.cowOrderUid
        );
        const settlementTxHash = trades[0]?.txHash;

        await updateCowOrderStatus(
          swap.swapId,
          status,
          settlementTxHash,
          executedBuyAmount
        );

        // Record metrics: completed swap and duration
        const durationSeconds = (Date.now() - swap.createdAt.getTime()) / 1000;
        recordSwapCompleted(swap.chainId, durationSeconds);

        console.log(
          `[Settlement] Swap ${swap.swapId} COMPLETE! ` +
            `Buy amount: ${executedBuyAmount}, Tx: ${settlementTxHash}, Duration: ${durationSeconds.toFixed(1)}s`
        );
      } else if (status === "EXPIRED" || status === "CANCELLED") {
        await updateCowOrderStatus(swap.swapId, status);

        console.log(
          `[Settlement] Swap ${swap.swapId} order ${status.toLowerCase()}. ` +
            `Will need refund processing.`
        );
      } else if (status !== swap.orderStatus) {
        // Status changed but not to a terminal state, just update
        await updateCowOrderStatus(swap.swapId, status);
      }
      // OPEN and PRESIGNATURE_PENDING - keep polling
    } catch (error) {
      // Log error but continue with other swaps
      console.error(`[Settlement] Error checking swap ${swap.swapId}:`, error);
      recordCowswapError(swap.chainId, "getOrderStatus");
    }
  }
}

/**
 * Start the settlement poller
 */
export function startSettlementPoller(): void {
  if (settlementInterval) {
    console.log("[Settlement] Poller already running");
    return;
  }

  console.log(
    `[Settlement] Starting settlement poller (interval: ${SETTLEMENT_POLL_INTERVAL_MS}ms)`
  );

  // Run immediately once
  pollSettlements().catch((err) =>
    console.error("[Settlement] Initial poll error:", err)
  );

  // Then run on interval
  settlementInterval = setInterval(() => {
    pollSettlements().catch((err) =>
      console.error("[Settlement] Poll error:", err)
    );
  }, SETTLEMENT_POLL_INTERVAL_MS);
}

/**
 * Stop the settlement poller
 */
export function stopSettlementPoller(): void {
  if (settlementInterval) {
    clearInterval(settlementInterval);
    settlementInterval = null;
    console.log("[Settlement] Poller stopped");
  }
}
