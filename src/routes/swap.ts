import { Elysia, t } from "elysia";
import { createDepositWallet } from "../services/wallet";
import { createSwap, getSwapById } from "../db/queries";
import { getChainConfig, isSupportedChainId } from "../config/chains";
import type {
  CreateSwapResponse,
  SupportedChainId,
  SwapStatusResponse,
  Token,
} from "../types";
import { serializeToken, deserializeToken } from "../utils/token";

function isValidAddress(address: string): address is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// Token schema for validation
const tokenSchema = t.Union([
  t.Object({ type: t.Literal("native") }),
  t.Object({ type: t.Literal("erc20"), address: t.String() }),
]);

const createSwapRequestSchema = t.Object({
  chainId: t.Number(),
  sellToken: tokenSchema,
  buyToken: tokenSchema,
  sellAmount: t.String(),
  recipientAddress: t.String(),
  refundAddress: t.String(),
});

export const swapRoutes = new Elysia({ prefix: "/swap" })
  // Create a new swap
  .post(
    "/",
    async ({ body, set }) => {
      const { chainId, sellToken, buyToken, sellAmount, recipientAddress, refundAddress } = body;

      // Validate chain ID
      if (!isSupportedChainId(chainId)) {
        set.status = 400;
        return { error: `Unsupported chain ID: ${chainId}` };
      }

      // Cast to Token type (validated by schema)
      const sellTokenTyped = sellToken as Token;
      const buyTokenTyped = buyToken as Token;

      // Validate recipient address format
      if (!isValidAddress(recipientAddress)) {
        set.status = 400;
        return { error: "Invalid recipient address" };
      }

      // Validate refund address format
      if (!isValidAddress(refundAddress)) {
        set.status = 400;
        return { error: "Invalid refund address" };
      }

      try {
        // Get chain config for TTL
        const chainConfig = getChainConfig(chainId as SupportedChainId);

        // Generate a new deposit wallet
        const depositWallet = createDepositWallet();

        // Generate swap ID (UUID v7 for time-ordered IDs)
        const swapId = Bun.randomUUIDv7();

        // Calculate expiry
        const now = new Date();
        const expiresAt = new Date(now.getTime() + chainConfig.swapTtlMs);

        // Create swap record in database
        // Tokens are serialized to JSON for storage
        const swap = await createSwap({
          swapId,
          chainId,
          depositAddress: depositWallet.address,
          depositPrivateKey: depositWallet.privateKey,
          sellToken: serializeToken(sellTokenTyped),
          buyToken: serializeToken(buyTokenTyped),
          expectedAmount: sellAmount,
          recipientAddress,
          refundAddress,
          status: "pending_deposit",
          expiresAt,
        });

        const response: CreateSwapResponse = {
          swapId: swap.swapId,
          depositAddress: swap.depositAddress as `0x${string}`,
          chainId: swap.chainId as SupportedChainId,
          sellToken: deserializeToken(swap.sellToken),
          buyToken: deserializeToken(swap.buyToken),
          expectedAmount: swap.expectedAmount,
          recipientAddress: swap.recipientAddress as `0x${string}`,
          refundAddress: swap.refundAddress as `0x${string}`,
          expiresAt: swap.expiresAt.getTime(),
          status: swap.status,
        };

        return response;
      } catch (error) {
        console.error("[Swap] Error creating swap:", error);
        set.status = 500;
        return { error: "Failed to create swap" };
      }
    },
    {
      body: createSwapRequestSchema,
    }
  )
  // Get swap status by ID
  .get("/:id", async ({ params, set }) => {
    const { id } = params;

    try {
      const swap = await getSwapById(id);

      if (!swap) {
        set.status = 404;
        return { error: "Swap not found" };
      }

      const response: SwapStatusResponse = {
        swapId: swap.swapId,
        chainId: swap.chainId as SupportedChainId,
        depositAddress: swap.depositAddress as `0x${string}`,
        sellToken: deserializeToken(swap.sellToken),
        buyToken: deserializeToken(swap.buyToken),
        expectedAmount: swap.expectedAmount,
        recipientAddress: swap.recipientAddress as `0x${string}`,
        refundAddress: swap.refundAddress as `0x${string}`,
        status: swap.status,
        createdAt: swap.createdAt.getTime(),
        expiresAt: swap.expiresAt.getTime(),
        depositTxHash: swap.depositTxHash || undefined,
        depositAmount: swap.depositAmount || undefined,
        settlementTxHash: swap.settlementTxHash || undefined,
        actualBuyAmount: swap.actualBuyAmount || undefined,
        failureReason: swap.failureReason || undefined,
        refundTxHash: swap.refundTxHash || undefined,
        refundAmount: swap.refundAmount || undefined,
      };

      return response;
    } catch (error) {
      console.error("[Swap] Error getting swap:", error);
      set.status = 500;
      return { error: "Failed to get swap" };
    }
  });
