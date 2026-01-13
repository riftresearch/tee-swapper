import {
  OrderBookApi,
  OrderQuoteSideKindSell,
  SupportedChainId as CowChainId,
  OrderKind,
  SigningScheme,
  SellTokenSource,
  BuyTokenDestination,
  type OrderQuoteRequest,
  type OrderQuoteResponse,
} from "@cowprotocol/cow-sdk";
import { type Address } from "viem";
import { signTypedData } from "viem/accounts";
import type { SupportedChainId, TokenAddress, CowOrderStatus, Token } from "../types";
import { getTokenAddress } from "../types";
import { getAccountFromPrivateKey } from "./wallet";
import { ORDER_VALIDITY_SECONDS } from "../config/constants";

// COW Protocol settlement contract address (same on all chains)
const COW_SETTLEMENT_CONTRACT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as Address;

// EIP712 domain for COW Protocol
function getCowDomain(chainId: SupportedChainId) {
  return {
    name: "Gnosis Protocol",
    version: "v2",
    chainId,
    verifyingContract: COW_SETTLEMENT_CONTRACT,
  } as const;
}

// EIP712 types for COW Protocol Order
const COW_ORDER_TYPES = {
  Order: [
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "receiver", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "buyAmount", type: "uint256" },
    { name: "validTo", type: "uint32" },
    { name: "appData", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "kind", type: "string" },
    { name: "partiallyFillable", type: "bool" },
    { name: "sellTokenBalance", type: "string" },
    { name: "buyTokenBalance", type: "string" },
  ],
} as const;

// Type for EIP712 order message (used for signing)
interface OrderMessage {
  sellToken: Address;
  buyToken: Address;
  receiver: Address;
  sellAmount: string;
  buyAmount: string;
  validTo: number;
  appData: `0x${string}`;
  feeAmount: string;
  kind: string;
  partiallyFillable: boolean;
  sellTokenBalance: string;
  buyTokenBalance: string;
}

/**
 * Get token address from Token - supports ERC20 and native ETH
 */
function tokenToAddress(token: Token): TokenAddress {
  return getTokenAddress(token);
}

function getOrderValidTo(): number {
  return Math.floor(Date.now() / 1000) + ORDER_VALIDITY_SECONDS;
}

// Map our chain IDs to COW Protocol chain IDs
function toCowChainId(chainId: SupportedChainId): CowChainId {
  switch (chainId) {
    case 1:
      return CowChainId.MAINNET;
    case 8453:
      return CowChainId.BASE;
    default:
      throw new Error(`Unsupported chain ID for COW Protocol: ${chainId}`);
  }
}

// Create OrderBook API client for a chain
function getOrderBookApi(chainId: SupportedChainId): OrderBookApi {
  return new OrderBookApi({ chainId: toCowChainId(chainId) });
}

export interface QuoteParams {
  chainId: SupportedChainId;
  sellToken: Token;
  buyToken: Token;
  sellAmount: string;
  from: Address;
}

export interface QuoteResult {
  quoteId: string;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  validTo: number;
  quote: OrderQuoteResponse;
}

/**
 * Get a quote from COW Protocol
 */
export async function getQuote(params: QuoteParams): Promise<QuoteResult> {
  const orderBookApi = getOrderBookApi(params.chainId);

  // Convert tokens to addresses
  const sellTokenAddress = tokenToAddress(params.sellToken);
  const buyTokenAddress = tokenToAddress(params.buyToken);

  const quoteRequest: OrderQuoteRequest = {
    sellToken: sellTokenAddress,
    buyToken: buyTokenAddress,
    from: params.from,
    receiver: params.from, // Will be updated when creating actual order
    sellAmountBeforeFee: params.sellAmount,
    kind: OrderQuoteSideKindSell.SELL,
  };

  const quote = await orderBookApi.getQuote(quoteRequest);

  return {
    quoteId: quote.id?.toString() || Bun.randomUUIDv7(),
    sellAmount: quote.quote.sellAmount,
    buyAmount: quote.quote.buyAmount,
    feeAmount: quote.quote.feeAmount,
    validTo: quote.quote.validTo,
    quote,
  };
}

export interface SwapOrderParams {
  chainId: SupportedChainId;
  sellToken: TokenAddress;
  buyToken: TokenAddress;
  sellAmount: string;
  buyAmountMin: string;
  receiver: Address;
  vaultPrivateKey: `0x${string}`;
  // validTo is intentionally omitted - we use MAX_VALID_TO so orders never expire
}

export interface SwapOrderWithAppDataParams extends SwapOrderParams {
  appDataHex: `0x${string}`;
  fullAppData: string;
}

export interface SwapOrderResult {
  orderId: string;
}

/**
 * Create and submit a swap order to COW Protocol
 */
export async function createSwapOrder(
  params: SwapOrderParams
): Promise<SwapOrderResult> {
  const orderBookApi = getOrderBookApi(params.chainId);

  // Get the account from the deposit wallet's private key
  const account = getAccountFromPrivateKey(params.vaultPrivateKey);

  const validTo = getOrderValidTo();
  const appData = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

  // Create the order message for EIP712 signing
  const orderMessage: OrderMessage = {
    sellToken: params.sellToken as Address,
    buyToken: params.buyToken as Address,
    receiver: params.receiver,
    sellAmount: params.sellAmount,
    buyAmount: params.buyAmountMin,
    validTo,
    appData,
    feeAmount: "0",
    kind: OrderKind.SELL,
    partiallyFillable: false,
    sellTokenBalance: SellTokenSource.ERC20,
    buyTokenBalance: BuyTokenDestination.ERC20,
  };

  // Sign the order using viem directly with EIP712
  // Cast message to any because viem's types are stricter than what EIP712 actually requires
  const signature = await signTypedData({
    privateKey: params.vaultPrivateKey,
    domain: getCowDomain(params.chainId),
    types: COW_ORDER_TYPES,
    primaryType: "Order",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    message: orderMessage as any,
  });

  // Submit the order
  const orderId = await orderBookApi.sendOrder({
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    receiver: params.receiver,
    sellAmount: params.sellAmount,
    buyAmount: params.buyAmountMin,
    validTo,
    appData,
    feeAmount: "0",
    kind: OrderKind.SELL,
    partiallyFillable: false,
    sellTokenBalance: SellTokenSource.ERC20,
    buyTokenBalance: BuyTokenDestination.ERC20,
    signature,
    signingScheme: SigningScheme.EIP712,
    from: account.address,
  });

  return { orderId };
}

/**
 * Create and submit a swap order with custom appData (for hooks like permits)
 *
 * This function:
 * 1. Creates and signs the order with the provided appDataHex
 * 2. Uploads the full appData content to COW's API
 * 3. Submits the order
 */
export async function createSwapOrderWithAppData(
  params: SwapOrderWithAppDataParams
): Promise<SwapOrderResult> {
  const orderBookApi = getOrderBookApi(params.chainId);

  // Get the account from the deposit wallet's private key
  const account = getAccountFromPrivateKey(params.vaultPrivateKey);

  const validTo = getOrderValidTo();

  // Create the order message for EIP712 signing
  const orderMessage: OrderMessage = {
    sellToken: params.sellToken as Address,
    buyToken: params.buyToken as Address,
    receiver: params.receiver,
    sellAmount: params.sellAmount,
    buyAmount: params.buyAmountMin,
    validTo,
    appData: params.appDataHex,
    feeAmount: "0",
    kind: OrderKind.SELL,
    partiallyFillable: false,
    sellTokenBalance: SellTokenSource.ERC20,
    buyTokenBalance: BuyTokenDestination.ERC20,
  };

  // Sign the order using viem directly with EIP712
  // Cast message to any because viem's types are stricter than what EIP712 actually requires
  const signature = await signTypedData({
    privateKey: params.vaultPrivateKey,
    domain: getCowDomain(params.chainId),
    types: COW_ORDER_TYPES,
    primaryType: "Order",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    message: orderMessage as any,
  });

  // Upload the full appData to COW's API so they know about the hooks
  await orderBookApi.uploadAppData(params.appDataHex, params.fullAppData);

  // Submit the order
  const orderId = await orderBookApi.sendOrder({
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    receiver: params.receiver,
    sellAmount: params.sellAmount,
    buyAmount: params.buyAmountMin,
    validTo,
    appData: params.appDataHex,
    feeAmount: "0",
    kind: OrderKind.SELL,
    partiallyFillable: false,
    sellTokenBalance: SellTokenSource.ERC20,
    buyTokenBalance: BuyTokenDestination.ERC20,
    signature,
    signingScheme: SigningScheme.EIP712,
    from: account.address,
  });

  return { orderId };
}

/**
 * Check if a quote can be filled
 */
export async function canFillQuote(params: QuoteParams): Promise<boolean> {
  try {
    await getQuote(params);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the status of a COWSwap order
 */
export interface OrderStatusResult {
  status: CowOrderStatus;
  executedBuyAmount?: string;
  executedSellAmount?: string;
}

export async function getOrderStatus(
  chainId: SupportedChainId,
  orderUid: string
): Promise<OrderStatusResult> {
  const orderBookApi = getOrderBookApi(chainId);

  try {
    const order = await orderBookApi.getOrder(orderUid);

    return {
      // COWSwap SDK uses lowercase status, but we use uppercase
      status: order.status.toUpperCase() as CowOrderStatus,
      executedBuyAmount: order.executedBuyAmount,
      executedSellAmount: order.executedSellAmount,
    };
  } catch (error) {
    // Order not found - could be expired or invalid UID
    throw new Error(`Failed to get order status for ${orderUid}: ${error}`);
  }
}

/**
 * Trade information from a filled order
 */
export interface TradeInfo {
  txHash: string;
  buyAmount: string;
  sellAmount: string;
  blockNumber: number;
}

/**
 * Get trades (fills) for a COWSwap order
 * An order can be filled across multiple trades
 */
export async function getOrderTrades(
  chainId: SupportedChainId,
  orderUid: string
): Promise<TradeInfo[]> {
  const orderBookApi = getOrderBookApi(chainId);

  const trades = await orderBookApi.getTrades({ orderUid });

  // Filter out trades without a txHash (shouldn't happen for settled trades)
  return trades
    .filter((trade): trade is typeof trade & { txHash: string } => trade.txHash !== null)
    .map((trade) => ({
      txHash: trade.txHash,
      buyAmount: trade.buyAmount,
      sellAmount: trade.sellAmount,
      blockNumber: trade.blockNumber,
    }));
}
