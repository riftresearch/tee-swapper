import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "./client";
import { swaps, type NewSwap, type Swap } from "./schema";
import type { SwapStatus, CowOrderStatus } from "../types";

/**
 * Get all pending swaps for a chain that haven't expired
 */
export async function getPendingSwaps(chainId: number): Promise<Swap[]> {
  return db
    .select()
    .from(swaps)
    .where(
      and(
        eq(swaps.chainId, chainId),
        eq(swaps.status, "pending_deposit"),
        gt(swaps.expiresAt, new Date())
      )
    );
}

/**
 * Get all swaps pending refund
 */
export async function getRefundPendingSwaps(chainId: number): Promise<Swap[]> {
  return db
    .select()
    .from(swaps)
    .where(
      and(
        eq(swaps.chainId, chainId),
        eq(swaps.status, "refund_pending")
      )
    );
}

/**
 * Get a swap by ID
 */
export async function getSwapById(swapId: string): Promise<Swap | undefined> {
  const results = await db
    .select()
    .from(swaps)
    .where(eq(swaps.swapId, swapId))
    .limit(1);
  return results[0];
}

/**
 * Get a swap by vault address
 */
export async function getSwapByVaultAddress(
  vaultAddress: string
): Promise<Swap | undefined> {
  const results = await db
    .select()
    .from(swaps)
    .where(eq(swaps.vaultAddress, vaultAddress))
    .limit(1);
  return results[0];
}

/**
 * Create a new swap
 */
export async function createSwap(swap: NewSwap): Promise<Swap> {
  const results = await db.insert(swaps).values(swap).returning();
  const result = results[0];
  if (!result) {
    throw new Error("Failed to create swap");
  }
  return result;
}

/**
 * Update swap status
 */
export async function updateSwapStatus(
  swapId: string,
  status: SwapStatus
): Promise<void> {
  await db
    .update(swaps)
    .set({ status, updatedAt: new Date() })
    .where(eq(swaps.swapId, swapId));
}

/**
 * Record deposit details when detected
 */
export async function recordDeposit(
  swapId: string,
  depositorAddress: string,
  depositTxHash: string,
  depositAmount: string
): Promise<void> {
  await db
    .update(swaps)
    .set({
      depositorAddress,
      depositTxHash,
      depositAmount,
      updatedAt: new Date(),
    })
    .where(eq(swaps.swapId, swapId));
}

/**
 * Mark swap as executing
 */
export async function markSwapExecuting(swapId: string): Promise<void> {
  await updateSwapStatus(swapId, "executing");
}

/**
 * Mark swap as failed and pending refund
 */
export async function markSwapFailedNeedsRefund(
  swapId: string,
  failureReason: string
): Promise<void> {
  await db
    .update(swaps)
    .set({
      status: "refund_pending",
      failureReason,
      updatedAt: new Date(),
    })
    .where(eq(swaps.swapId, swapId));
}

/**
 * Mark swap as failed (no deposit, no refund needed)
 */
export async function markSwapFailed(
  swapId: string,
  failureReason: string
): Promise<void> {
  await db
    .update(swaps)
    .set({
      status: "failed",
      failureReason,
      updatedAt: new Date(),
    })
    .where(eq(swaps.swapId, swapId));
}

/**
 * Mark swap as refunded
 */
export async function markSwapRefunded(
  swapId: string,
  refundTxHash: string,
  refundAmount: string
): Promise<void> {
  await db
    .update(swaps)
    .set({
      status: "refunded",
      refundTxHash,
      refundAmount,
      updatedAt: new Date(),
    })
    .where(eq(swaps.swapId, swapId));
}

/**
 * Mark expired swaps - call periodically to clean up
 * Returns swaps that were expired (for refund processing)
 */
export async function markExpiredSwaps(): Promise<number> {
  const result = await db
    .update(swaps)
    .set({ status: "expired", updatedAt: new Date() })
    .where(
      and(
        eq(swaps.status, "pending_deposit"),
        lt(swaps.expiresAt, new Date())
      )
    );
  return result.count;
}

/**
 * Get expired swaps that have deposits (need refunds)
 */
export async function getExpiredSwapsWithDeposits(chainId: number): Promise<Swap[]> {
  return db
    .select()
    .from(swaps)
    .where(
      and(
        eq(swaps.chainId, chainId),
        eq(swaps.status, "expired")
      )
    );
}

/**
 * Mark expired swap as needing refund (if it has a deposit)
 */
export async function markExpiredForRefund(swapId: string): Promise<void> {
  await updateSwapStatus(swapId, "refund_pending");
}

// ============================================
// Settlement Tracking Queries
// ============================================

/**
 * Get all swaps in "executing" status that need settlement tracking
 */
export async function getExecutingSwaps(): Promise<Swap[]> {
  return db.select().from(swaps).where(eq(swaps.status, "executing"));
}

/**
 * Save the COWSwap order UID after order submission
 */
export async function saveOrderUid(
  swapId: string,
  cowOrderUid: string
): Promise<void> {
  await db
    .update(swaps)
    .set({
      cowOrderUid,
      orderStatus: "OPEN",
      updatedAt: new Date(),
    })
    .where(eq(swaps.swapId, swapId));
}

/**
 * Update order status from COWSwap API polling
 * Automatically transitions swap status based on order status:
 * - FULFILLED → complete
 * - EXPIRED/CANCELLED → refund_pending (with failure reason)
 */
export async function updateCowOrderStatus(
  swapId: string,
  orderStatus: CowOrderStatus,
  settlementTxHash?: string,
  actualBuyAmount?: string
): Promise<void> {
  const updates: Partial<Swap> & { updatedAt: Date } = {
    orderStatus,
    updatedAt: new Date(),
  };

  if (settlementTxHash) {
    updates.settlementTxHash = settlementTxHash;
  }

  if (actualBuyAmount) {
    updates.actualBuyAmount = actualBuyAmount;
  }

  // Auto-transition swap status based on order status
  if (orderStatus === "FULFILLED") {
    updates.status = "complete";
  } else if (orderStatus === "EXPIRED") {
    updates.status = "refund_pending";
    updates.failureReason = "COWSwap order expired without being filled";
  } else if (orderStatus === "CANCELLED") {
    updates.status = "refund_pending";
    updates.failureReason = "COWSwap order was cancelled";
  }

  await db.update(swaps).set(updates).where(eq(swaps.swapId, swapId));
}

// ============================================
// Metrics Queries
// ============================================

/**
 * Get counts of swaps grouped by status and chain
 * Used for Prometheus metrics
 */
export async function getSwapCountsByStatusAndChain(): Promise<
  Array<{ chainId: number; status: string; count: number }>
> {
  const results = await db
    .select({
      chainId: swaps.chainId,
      status: swaps.status,
      count: sql<number>`count(*)::int`,
    })
    .from(swaps)
    .groupBy(swaps.chainId, swaps.status);

  return results.map((r) => ({
    chainId: r.chainId,
    status: r.status,
    count: r.count,
  }));
}
