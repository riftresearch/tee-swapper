import { Elysia, t } from "elysia";
import { getAddress, isAddress } from "viem";
import { createVaultWallet } from "../services/wallet";
import { createSwap, getSwapById } from "../db/queries";
import { getChainConfig, isSupportedChainId } from "../config/chains";
import { CBBTC_ADDRESSES } from "../config/constants";
import type {
  CreateSwapResponse,
  SupportedChainId,
  SwapStatusResponse,
  Token,
} from "../types";
import { serializeToken, deserializeToken } from "../utils/token";

/**
 * Validate and normalize an Ethereum address to checksummed format.
 * Returns null if invalid, or the checksummed address if valid.
 */
function normalizeAddress(address: string): `0x${string}` | null {
  if (!isAddress(address)) {
    return null;
  }
  return getAddress(address);
}

// Token schemas for validation - supports ERC20 and native ETH
const erc20TokenSchema = t.Object({ type: t.Literal("erc20"), address: t.String() });
const etherTokenSchema = t.Object({ type: t.Literal("ether") });
const tokenSchema = t.Union([erc20TokenSchema, etherTokenSchema]);

// Request schema - sellToken is always CBBTC, amount is determined by deposit
const createSwapRequestSchema = t.Object({
  chainId: t.Number(),
  buyToken: tokenSchema,
  recipientAddress: t.String(),
  refundAddress: t.String(),
});

export const swapRoutes = new Elysia({ prefix: "/swap" })
  // Create a new swap
  .post(
    "/",
    async ({ body, set }) => {
      const { chainId, buyToken, recipientAddress, refundAddress } = body;

      // Validate chain ID
      if (!isSupportedChainId(chainId)) {
        set.status = 400;
        return { error: `Unsupported chain ID: ${chainId}` };
      }

      // Get CBBTC address for this chain (the only supported input token)
      const cbbtcAddress = CBBTC_ADDRESSES[chainId];
      if (!cbbtcAddress) {
        set.status = 400;
        return { error: `CBBTC not supported on chain ${chainId}` };
      }

      // sellToken is always CBBTC
      const sellTokenTyped: Token = { type: "erc20", address: cbbtcAddress };

      // Handle buyToken - can be ERC20 or native ETH
      let buyTokenTyped: Token;
      if (buyToken.type === "ether") {
        buyTokenTyped = { type: "ether" };
      } else {
        // Normalize and validate buyToken address for ERC20
        const normalizedBuyTokenAddress = normalizeAddress(buyToken.address);
        if (!normalizedBuyTokenAddress) {
          set.status = 400;
          return { error: "Invalid buyToken address" };
        }
        buyTokenTyped = { type: "erc20", address: normalizedBuyTokenAddress };
      }

      // Validate and normalize recipient address
      const normalizedRecipient = normalizeAddress(recipientAddress);
      if (!normalizedRecipient) {
        set.status = 400;
        return { error: "Invalid recipient address" };
      }

      // Validate and normalize refund address
      const normalizedRefund = normalizeAddress(refundAddress);
      if (!normalizedRefund) {
        set.status = 400;
        return { error: "Invalid refund address" };
      }

      try {
        // Get chain config for TTL
        const chainConfig = getChainConfig(chainId as SupportedChainId);

        // Generate a new vault wallet
        const vaultWallet = createVaultWallet();

        // Generate swap ID (UUID v7 for time-ordered IDs)
        const swapId = Bun.randomUUIDv7();

        // Calculate expiry
        const now = new Date();
        const expiresAt = new Date(now.getTime() + chainConfig.swapTtlMs);

        // Create swap record in database
        // Tokens are serialized to JSON for storage
        // All addresses are normalized to checksummed format
        // Only the salt is stored - private key is derived at runtime
        const swap = await createSwap({
          swapId,
          chainId,
          vaultAddress: vaultWallet.address,
          vaultSalt: vaultWallet.salt,
          sellToken: serializeToken(sellTokenTyped),
          buyToken: serializeToken(buyTokenTyped),
          recipientAddress: normalizedRecipient,
          refundAddress: normalizedRefund,
          status: "pending_deposit",
          expiresAt,
        });

        const response: CreateSwapResponse = {
          swapId: swap.swapId,
          vaultAddress: swap.vaultAddress as `0x${string}`,
          chainId: swap.chainId as SupportedChainId,
          buyToken: deserializeToken(swap.buyToken),
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
        vaultAddress: swap.vaultAddress as `0x${string}`,
        buyToken: deserializeToken(swap.buyToken),
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
