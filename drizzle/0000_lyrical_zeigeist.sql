CREATE TYPE "public"."swap_status" AS ENUM('pending_deposit', 'executing', 'complete', 'failed', 'expired', 'refund_pending', 'refunded');--> statement-breakpoint
CREATE TABLE "swaps" (
	"swap_id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"deposit_address" text NOT NULL,
	"deposit_private_key" text NOT NULL,
	"sell_token" text NOT NULL,
	"buy_token" text NOT NULL,
	"expected_amount" text NOT NULL,
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
	"refund_tx_hash" text,
	"refund_amount" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "swaps_deposit_address_unique" UNIQUE("deposit_address")
);
--> statement-breakpoint
CREATE INDEX "idx_pending_by_chain" ON "swaps" USING btree ("chain_id","status");--> statement-breakpoint
CREATE INDEX "idx_deposit_address" ON "swaps" USING btree ("deposit_address");