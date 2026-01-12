import {
  type Address,
  type PublicClient,
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  parseEventLogs,
  hashTypedData,
  concat,
  pad,
  toHex,
} from "viem";
import { mainnet, base } from "viem/chains";
import { publicActionsL2 } from "viem/op-stack";
import type { Swap } from "../../db/schema";
import type { ExecutionResult, SupportedChainId, TokenAddress, Token } from "../../types";
import { isNativeToken, isErc20Token } from "../../types";
import { deserializeToken } from "../../utils/token";
import { getAccountFromPrivateKey } from "../wallet";
import { getQuote } from "../cowswap";
import {
  ORDER_VALIDITY_SECONDS,
  GPV2_SETTLEMENT_ADDRESS,
  MIN_ETH_SELL_AMOUNT,
  GAS_BUFFER_PERCENT,
} from "../../config/constants";

// EthFlow contract address per chain
export const ETHFLOW_ADDRESS_BY_CHAIN_ID = {
  1: "0x40A50cf069e992AA4536211B23F286eF88752187" as const,
  8453: "0xbA3cB449bD2B4ADddBc894D8697F5170800EAdeC" as const,
} as const;

// WETH addresses per chain - EthFlow wraps ETH to WETH for the order
const WETH_ADDRESS_BY_CHAIN_ID = {
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const,
  8453: "0x4200000000000000000000000000000000000006" as const, // Base WETH
} as const;

// Gas buffer for transaction estimation
// Applied to both gas limit and gas price for safety margin
// Using 300% (3x) for each, giving 9x total buffer on gas cost
const GAS_BUFFER_MULTIPLIER = 300n;
const GAS_BUFFER_DIVISOR = 100n;

function getOrderValidTo(): number {
  return Math.floor(Date.now() / 1000) + ORDER_VALIDITY_SECONDS;
}

/**
 * Get token address from Token type
 * Throws if token is native since EthFlow buyToken must be an ERC20
 */
function requireErc20Token(token: Token, context: string): TokenAddress {
  if (isNativeToken(token)) {
    throw new Error(`${context} cannot be native ETH in EthFlow`);
  }
  return token.address;
}

// EIP-712 type definition for COWSwap Order
const ORDER_TYPE = {
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

// GPv2Order.Data struct from the OrderPlacement event
// This is the full order struct including sellToken and balance types
interface GPv2OrderData {
  sellToken: Address;
  buyToken: Address;
  receiver: Address;
  sellAmount: bigint;
  buyAmount: bigint;
  validTo: number;
  appData: `0x${string}`;
  feeAmount: bigint;
  kind: `0x${string}`;
  partiallyFillable: boolean;
  sellTokenBalance: `0x${string}`;
  buyTokenBalance: `0x${string}`;
}

// Constants for order kind and balance - these are bytes32 values
const ORDER_KIND_SELL = "0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775" as const;
const ORDER_BALANCE_ERC20 = "0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9" as const;

/**
 * Compute the EIP-712 order digest for a COWSwap order
 * This is the hash that gets signed and used in the order UID
 */
function computeOrderDigest(
  orderStruct: GPv2OrderData,
  chainId: SupportedChainId
): `0x${string}` {
  return hashTypedData({
    domain: {
      name: "Gnosis Protocol",
      version: "v2",
      chainId,
      verifyingContract: GPV2_SETTLEMENT_ADDRESS,
    },
    types: ORDER_TYPE,
    primaryType: "Order",
    message: {
      sellToken: orderStruct.sellToken,
      buyToken: orderStruct.buyToken,
      receiver: orderStruct.receiver,
      sellAmount: orderStruct.sellAmount,
      buyAmount: orderStruct.buyAmount,
      validTo: orderStruct.validTo,
      appData: orderStruct.appData,
      feeAmount: orderStruct.feeAmount,
      // Convert bytes32 kind to string for EIP-712 signing
      kind: "sell",
      partiallyFillable: orderStruct.partiallyFillable,
      sellTokenBalance: "erc20",
      buyTokenBalance: "erc20",
    },
  });
}

/**
 * Pack the order UID from its components
 * Order UID format: orderDigest (32 bytes) + owner (20 bytes) + validTo (4 bytes) = 56 bytes
 *
 * CRITICAL: For EthFlow orders, the owner is ETHFLOW_ADDRESS, not the user's address!
 */
function packOrderUid(
  orderDigest: `0x${string}`,
  owner: Address,
  validTo: number
): `0x${string}` {
  // validTo is uint32, so we need 4 bytes
  const validToBytes = pad(toHex(validTo), { size: 4 });

  // Concatenate: digest (32) + owner (20) + validTo (4)
  return concat([orderDigest, owner, validToBytes]);
}

// Minimal ABI for EthFlow contract
const ETHFLOW_ABI = [
  {
    name: "createOrder",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "buyToken", type: "address" },
          { name: "receiver", type: "address" },
          { name: "sellAmount", type: "uint256" },
          { name: "buyAmount", type: "uint256" },
          { name: "appData", type: "bytes32" },
          { name: "feeAmount", type: "uint256" },
          { name: "validTo", type: "uint32" },
          { name: "partiallyFillable", type: "bool" },
          { name: "quoteId", type: "int64" },
        ],
      },
    ],
    outputs: [{ name: "orderHash", type: "bytes32" }],
  },
  {
    // OrderPlacement event emits GPv2Order.Data struct (includes sellToken)
    // This is different from createOrder input which uses EthFlowOrder.Data (no sellToken)
    name: "OrderPlacement",
    type: "event",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "order", type: "tuple", indexed: false, components: [
        { name: "sellToken", type: "address" },
        { name: "buyToken", type: "address" },
        { name: "receiver", type: "address" },
        { name: "sellAmount", type: "uint256" },
        { name: "buyAmount", type: "uint256" },
        { name: "validTo", type: "uint32" },
        { name: "appData", type: "bytes32" },
        { name: "feeAmount", type: "uint256" },
        { name: "kind", type: "bytes32" },
        { name: "partiallyFillable", type: "bool" },
        { name: "sellTokenBalance", type: "bytes32" },
        { name: "buyTokenBalance", type: "bytes32" },
      ]},
      { name: "signature", type: "tuple", indexed: false, components: [
        { name: "scheme", type: "uint8" },
        { name: "data", type: "bytes" },
      ]},
      { name: "data", type: "bytes", indexed: false },
    ],
  },
] as const;

// Viem chain config map
const viemChains = {
  1: mainnet,
  8453: base,
} as const;

/**
 * Execute a native ETH swap via the EthFlow contract
 *
 * The EthFlow contract wraps ETH and creates a COWSwap order in a single transaction.
 * Gas is reserved from the deposit amount to pay for the transaction.
 *
 * Supported chains: Mainnet (1), Base (8453)
 */
export async function executeEthFlow(
  swap: Swap,
  client: PublicClient
): Promise<ExecutionResult> {
  const chainId = swap.chainId as SupportedChainId;

  // Validate chain is supported
  const ethFlowAddress = ETHFLOW_ADDRESS_BY_CHAIN_ID[chainId];
  if (!ethFlowAddress) {
    throw new Error(`EthFlow is not available on chain ${chainId}`);
  }

  // Deserialize tokens from DB storage
  const sellToken = deserializeToken(swap.sellToken);
  const buyToken = deserializeToken(swap.buyToken);

  // Validate buyToken is an ERC20 (not native ETH)
  // EthFlow is for selling ETH, not buying it
  const buyTokenAddress = requireErc20Token(buyToken, "buyToken");

  const chain = viemChains[chainId];
  const account = getAccountFromPrivateKey(swap.depositPrivateKey as `0x${string}`);

  // Get the actual ETH balance in the deposit address
  const depositBalance = await client.getBalance({ address: account.address });

  console.log(`[EthFlow] Deposit balance: ${depositBalance} wei`);

  // Create wallet client for signing transactions
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(),
  });

  // First, estimate gas with a placeholder order to calculate gas cost
  // EthFlow contract requires value == sellAmount, so we use a consistent value
  const estimationValue = depositBalance / 2n;
  const placeholderOrder = {
    buyToken: buyTokenAddress as Address,
    receiver: swap.recipientAddress as Address,
    sellAmount: estimationValue, // Must match the value sent
    buyAmount: 1n, // Placeholder - just needs to be non-zero
    appData: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
    feeAmount: 0n,
    validTo: getOrderValidTo(),
    partiallyFillable: false,
    quoteId: 0n,
  };

  const placeholderData = encodeFunctionData({
    abi: ETHFLOW_ABI,
    functionName: "createOrder",
    args: [placeholderOrder],
  });

  // Estimate gas for the transaction
  const gasEstimate = await client.estimateGas({
    account: account.address,
    to: ethFlowAddress,
    data: placeholderData,
    value: estimationValue, // Must match sellAmount in the order
  });

  // Add buffer to gas estimate
  const gasWithBuffer = (gasEstimate * GAS_BUFFER_MULTIPLIER) / GAS_BUFFER_DIVISOR;

  // Get EIP-1559 fee estimates
  const fees = await client.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas!;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas!;

  // Apply buffer to maxFeePerGas to account for fluctuations
  const maxFeeWithBuffer = (maxFeePerGas * GAS_BUFFER_MULTIPLIER) / GAS_BUFFER_DIVISOR;

  // Calculate the L2 execution cost (same for both L1 and L2)
  // This is what the RPC checks: gas * maxFeePerGas
  const l2ExecutionCost = gasWithBuffer * maxFeeWithBuffer;

  // For L2 chains (Base), we also need to account for L1 data fees
  // The L1 data fee is paid FROM THE VALUE, not from gas, but we need to reserve for it
  let l1DataFee = 0n;

  if (chainId === 8453) {
    // Base is an OP Stack L2 - get L1 data fee estimate
    const l2Client = createPublicClient({
      chain: base,
      transport: http(),
    }).extend(publicActionsL2());

    l1DataFee = await l2Client.estimateL1Fee({
      account: account.address,
      to: ethFlowAddress,
      data: placeholderData,
      value: estimationValue,
    });

    // Apply buffer to L1 data fee (can fluctuate with L1 gas prices)
    l1DataFee = (l1DataFee * GAS_BUFFER_MULTIPLIER) / GAS_BUFFER_DIVISOR;
    console.log(`[EthFlow] L2 execution cost: ${l2ExecutionCost} wei, L1 data fee (buffered): ${l1DataFee} wei`);
  } else {
    console.log(`[EthFlow] L1 gas estimate: ${gasEstimate}, maxFeePerGas: ${maxFeePerGas}, total gas cost: ${l2ExecutionCost} wei`);
  }

  // Total reserved = L2 execution cost + L1 data fee + 5% safety margin
  const totalGasCost = l2ExecutionCost + l1DataFee;
  const safetyMargin = totalGasCost / 20n; // 5%
  const totalReservedForGas = totalGasCost + safetyMargin;

  console.log(`[EthFlow] Total reserved for gas: ${totalReservedForGas} wei (includes ${safetyMargin} wei safety margin)`);

  // Calculate the actual sell amount (deposit - gas cost - safety margin)
  const actualSellAmount = depositBalance - totalReservedForGas;

  if (actualSellAmount < MIN_ETH_SELL_AMOUNT) {
    throw new Error(
      `Insufficient ETH after gas reservation. ` +
      `Deposit: ${depositBalance} wei, Reserved for gas: ${totalReservedForGas} wei, ` +
      `Remaining: ${actualSellAmount} wei, Minimum: ${MIN_ETH_SELL_AMOUNT} wei`
    );
  }

  console.log(`[EthFlow] Actual sell amount after gas: ${actualSellAmount} wei`);

  // Get a fresh quote for the actual sell amount
  // Note: getQuote internally converts native ETH to WETH for the COWSwap API
  const quote = await getQuote({
    chainId,
    sellToken, // Native ETH will be converted to WETH internally
    buyToken,  // Already validated as ERC20
    sellAmount: actualSellAmount.toString(),
    from: swap.depositAddress as Address,
  });

  // Build the EthFlow order struct - valid for 24 hours
  const ethFlowOrder = {
    buyToken: buyTokenAddress as Address,
    receiver: swap.recipientAddress as Address,
    sellAmount: BigInt(quote.sellAmount),
    buyAmount: BigInt(quote.buyAmount),
    appData: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
    feeAmount: BigInt(quote.feeAmount),
    validTo: getOrderValidTo(),
    partiallyFillable: false,
    quoteId: BigInt(quote.quoteId || 0),
  };

  // Encode the createOrder call
  const data = encodeFunctionData({
    abi: ETHFLOW_ABI,
    functionName: "createOrder",
    args: [ethFlowOrder],
  });

  // Send the transaction with the ETH value (sell amount + fee amount)
  // EthFlow requires: msg.value == sellAmount + feeAmount
  const totalValue = BigInt(quote.sellAmount) + BigInt(quote.feeAmount);
  console.log(`[EthFlow] Sending ${totalValue} wei (sellAmount: ${quote.sellAmount}, feeAmount: ${quote.feeAmount})`);

  // Get fresh priority fee but cap maxFee at what we reserved for
  const freshFees = await client.estimateFeesPerGas();
  const freshPriorityFee = freshFees.maxPriorityFeePerGas!;

  // Use the maxFeeWithBuffer we calculated - this is what we reserved for in actualSellAmount
  // If network price exceeds this, the transaction will fail, but that's better than running out of funds
  console.log(`[EthFlow] Final gas params: gas=${gasWithBuffer}, maxFee=${maxFeeWithBuffer}, priorityFee=${freshPriorityFee}`);

  const txHash = await walletClient.sendTransaction({
    to: ethFlowAddress,
    data,
    value: totalValue,
    gas: gasWithBuffer,
    maxFeePerGas: maxFeeWithBuffer,
    maxPriorityFeePerGas: freshPriorityFee,
  });

  console.log(`[EthFlow] Transaction sent: ${txHash}`);

  // Wait for the transaction to be mined
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
  });

  if (receipt.status === "reverted") {
    throw new Error(`EthFlow transaction reverted: ${txHash}`);
  }

  // Parse the OrderPlacement event to get the order struct
  const logs = parseEventLogs({
    abi: ETHFLOW_ABI,
    logs: receipt.logs,
    eventName: "OrderPlacement",
  });

  if (logs.length === 0) {
    throw new Error(`EthFlow transaction succeeded but no OrderPlacement event found: ${txHash}`);
  }

  const event = logs[0];
  if (!event) {
    throw new Error(`EthFlow event parsing failed: ${txHash}`);
  }

  // Extract the order struct from the event (GPv2Order.Data format)
  const orderStruct = event.args.order as GPv2OrderData;

  // Compute the order digest (EIP-712 hash)
  const orderDigest = computeOrderDigest(orderStruct, chainId);

  // Pack into 56-byte order UID
  // CRITICAL: owner is the EthFlow contract address, not the user's address!
  // Also ensure lowercase for API compatibility
  const orderId = packOrderUid(orderDigest, ethFlowAddress, orderStruct.validTo).toLowerCase() as `0x${string}`;

  console.log(`[EthFlow] Order placed successfully: ${orderId}`);

  return {
    orderId,
    buyAmount: quote.buyAmount,
  };
}
