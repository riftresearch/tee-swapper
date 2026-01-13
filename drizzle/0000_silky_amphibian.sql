CREATE TYPE "public"."swap_status" AS ENUM('pending_deposit', 'executing', 'complete', 'failed', 'expired', 'refund_pending', 'refunded');--> statement-breakpoint
CREATE TABLE "swaps" (
	"swap_id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"vault_address" text NOT NULL,
	"vault_salt" text NOT NULL,
	"sell_token" text NOT NULL,
	"buy_token" text NOT NULL,
	"recipient_address" text NOT NULL,
	"refund_address" text NOT NULL,
	"status" "swap_status" DEFAULT 'pending_deposit' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"depositor_address" text,
	"deposit_tx_hash" text,
	"deposit_amount" text,
	"cow_order_uid" text,
	"order_status" text,
	"settlement_tx_hash" text,
	"actual_buy_amount" text,
	"failure_reason" text,
	"refund_tx_hash" text,
	"refund_amount" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "swaps_vault_address_unique" UNIQUE("vault_address")
);
--> statement-breakpoint
CREATE INDEX "idx_pending_by_chain_expires" ON "swaps" USING btree ("chain_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_vault_address" ON "swaps" USING btree ("vault_address");--> statement-breakpoint
CREATE INDEX "idx_status" ON "swaps" USING btree ("status");