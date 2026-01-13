import { Elysia, t } from "elysia";
import { getQuote } from "../services/cowswap";
import { createVaultWallet } from "../services/wallet";
import { isSupportedChainId } from "../config/chains";
import { CBBTC_ADDRESSES } from "../config/constants";
import type { QuoteResponse, SupportedChainId, Token } from "../types";

// Token schemas for validation - supports ERC20 and native ETH
const erc20TokenSchema = t.Object({ type: t.Literal("erc20"), address: t.String() });
const etherTokenSchema = t.Object({ type: t.Literal("ether") });
const tokenSchema = t.Union([erc20TokenSchema, etherTokenSchema]);

// Request schema - sellToken is always CBBTC (not specified by caller)
const quoteRequestSchema = t.Object({
  chainId: t.Number(),
  buyToken: tokenSchema,
  sellAmount: t.String(),
});

export const quoteRoutes = new Elysia({ prefix: "/quote" }).post(
  "/",
  async ({ body, set }) => {
    const { chainId, buyToken, sellAmount } = body;

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
    const buyTokenTyped = buyToken as Token;

    // Create a temporary wallet for the quote (we need a "from" address)
    const tempWallet = createVaultWallet();

    try {

      // Get quote from COW Protocol
      const quote = await getQuote({
        chainId: chainId as SupportedChainId,
        sellToken: sellTokenTyped,
        buyToken: buyTokenTyped,
        sellAmount,
        from: tempWallet.address,
      });

      const response: QuoteResponse = {
        quoteId: quote.quoteId,
        chainId: chainId as SupportedChainId,
        buyToken: buyTokenTyped,
        sellAmount: quote.sellAmount,
        buyAmountEstimate: quote.buyAmount,
        expiresAt: quote.validTo * 1000, // Convert to milliseconds
        canFill: true,
      };

      return response;
    } catch (error) {
      console.error("[Quote] Error getting quote:", error);

      // Extract error message from COWSwap
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Return 400 with the actual error from COWSwap
      // Common errors: "SellAmountDoesNotCoverFee", "NoLiquidity", etc.
      set.status = 400;
      return {
        error: errorMessage,
        canFill: false,
      };
    }
  },
  {
    body: quoteRequestSchema,
  }
);
