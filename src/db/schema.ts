import { pgTable, text, integer, timestamp, pgEnum, index } from "drizzle-orm/pg-core";

export const swapStatusEnum = pgEnum("swap_status", [
  "pending_deposit",
  "executing",
  "complete",
  "failed",
  "expired",
  "refund_pending",
  "refunded",
]);

export const swaps = pgTable(
  "swaps",
  {
    swapId: text("swap_id").primaryKey(),
    chainId: integer("chain_id").notNull(),
    vaultAddress: text("vault_address").notNull().unique(),
    vaultSalt: text("vault_salt").notNull(),  // Salt for deriving private key (not the key itself)
    sellToken: text("sell_token").notNull(),
    buyToken: text("buy_token").notNull(),
    recipientAddress: text("recipient_address").notNull(),
    refundAddress: text("refund_address").notNull(),
    status: swapStatusEnum("status").notNull().default("pending_deposit"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    
    // Deposit tracking
    depositorAddress: text("depositor_address"),
    depositTxHash: text("deposit_tx_hash"),
    depositAmount: text("deposit_amount"),
    
    // Execution tracking
    cowOrderUid: text("cow_order_uid"),           // COWSwap order UID (56 bytes hex)
    orderStatus: text("order_status"),            // COWSwap order status: OPEN, FULFILLED, etc.
    settlementTxHash: text("settlement_tx_hash"), // Transaction that filled the order
    actualBuyAmount: text("actual_buy_amount"),

    // Failure tracking
    failureReason: text("failure_reason"),        // Human-readable reason for failure
    
    // Refund tracking
    refundTxHash: text("refund_tx_hash"),
    refundAmount: text("refund_amount"),
    
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // Composite index for getPendingSwaps: WHERE chainId = ? AND status = ? AND expiresAt > now()
    index("idx_pending_by_chain_expires").on(table.chainId, table.status, table.expiresAt),
    index("idx_vault_address").on(table.vaultAddress),
    // Index for settlement poller: WHERE status = 'executing'
    index("idx_status").on(table.status),
  ]
);

export type Swap = typeof swaps.$inferSelect;
export type NewSwap = typeof swaps.$inferInsert;
