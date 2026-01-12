import { Elysia, t } from "elysia";
import { getQuote, canFillQuote } from "../services/cowswap";
import { createDepositWallet } from "../services/wallet";
import { isSupportedChainId } from "../config/chains";
import type { QuoteResponse, SupportedChainId, Token, TokenAddress } from "../types";

// Token schema for validation
const tokenSchema = t.Union([
  t.Object({ type: t.Literal("native") }),
  t.Object({ type: t.Literal("erc20"), address: t.String() }),
]);

const quoteRequestSchema = t.Object({
  chainId: t.Number(),
  sellToken: tokenSchema,
  buyToken: tokenSchema,
  sellAmount: t.String(),
});

export const quoteRoutes = new Elysia({ prefix: "/quote" }).post(
  "/",
  async ({ body, set }) => {
    const { chainId, sellToken, buyToken, sellAmount } = body;

    // Validate chain ID
    if (!isSupportedChainId(chainId)) {
      set.status = 400;
      return { error: `Unsupported chain ID: ${chainId}` };
    }

    // Cast to Token type (validated by schema)
    const sellTokenTyped = sellToken as Token;
    const buyTokenTyped = buyToken as Token;

    try {
      // Create a temporary wallet for the quote (we need a "from" address)
      const tempWallet = createDepositWallet();

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
        sellToken: sellTokenTyped,
        buyToken: buyTokenTyped,
        sellAmount: quote.sellAmount,
        buyAmountEstimate: quote.buyAmount,
        expiresAt: quote.validTo * 1000, // Convert to milliseconds
        canFill: true,
      };

      return response;
    } catch (error) {
      console.error("[Quote] Error getting quote:", error);

      // Check if we can fill at all
      const tempWallet2 = createDepositWallet();
      const canFill = await canFillQuote({
        chainId: chainId as SupportedChainId,
        sellToken: sellTokenTyped,
        buyToken: buyTokenTyped,
        sellAmount,
        from: tempWallet2.address,
      });

      if (!canFill) {
        set.status = 400;
        return {
          error: "Cannot fill this swap request",
          canFill: false,
        };
      }

      set.status = 500;
      return { error: "Failed to get quote" };
    }
  },
  {
    body: quoteRequestSchema,
  }
);
