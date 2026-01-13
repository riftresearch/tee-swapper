import {
  type Address,
  type PublicClient,
  keccak256,
  stringToHex,
  encodeFunctionData,
  maxUint256,
} from "viem";
import { signTypedData } from "viem/accounts";
import { stringifyDeterministic } from "@cowprotocol/sdk-app-data";
import type { Swap } from "../../db/schema";
import type { ExecutionResult, SupportedChainId, TokenAddress } from "../../types";
import { getTokenAddress } from "../../types";
import { deserializeToken } from "../../utils/token";
import { createSwapOrderWithAppData, getQuote } from "../cowswap";
import { getVaultWalletFromSalt } from "../wallet";
import { GPV2_VAULT_RELAYER } from "../../config/constants";
import { chains } from "../../config/chains";
import { createPublicClient, http } from "viem";
import { getSlippageTolerance, applySlippageToBuyAmount } from "../slippage";

/**
 * CBBTC permit configuration
 * CBBTC uses standard EIP-2612 permits with version "2"
 * (from FiatTokenV2 contract)
 */
const CBBTC_PERMIT_CONFIG = {
  name: "Coinbase Wrapped BTC",
  version: "2",
} as const;

/**
 * EIP-2612 Permit types for EIP-712 signing
 */
const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/**
 * ABI for EIP-2612 permit functions
 */
const PERMIT_ABI = [
  {
    name: "permit",
    type: "function",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "nonces",
    type: "function",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

/**
 * Get a public client for the given chain
 */
function getPublicClient(chainId: SupportedChainId): PublicClient {
  const chainConfig = chains[chainId];
  return createPublicClient({
    transport: http(chainConfig.rpcUrl),
  });
}

/**
 * Get the current nonce for an address on an EIP-2612 token
 */
async function getPermitNonce(
  client: PublicClient,
  tokenAddress: TokenAddress,
  owner: Address
): Promise<bigint> {
  const nonce = await client.readContract({
    address: tokenAddress as Address,
    abi: PERMIT_ABI,
    functionName: "nonces",
    args: [owner],
  });
  return nonce;
}

/**
 * Sign an EIP-2612 permit
 */
async function signPermit(
  chainId: SupportedChainId,
  tokenAddress: TokenAddress,
  privateKey: `0x${string}`,
  owner: Address,
  spender: Address,
  value: bigint,
  nonce: bigint,
  deadline: bigint
): Promise<{ v: number; r: `0x${string}`; s: `0x${string}` }> {
  const domain = {
    name: CBBTC_PERMIT_CONFIG.name,
    version: CBBTC_PERMIT_CONFIG.version,
    chainId,
    verifyingContract: tokenAddress as Address,
  };

  const message = {
    owner,
    spender,
    value,
    nonce,
    deadline,
  };

  const signature = await signTypedData({
    privateKey,
    domain,
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message,
  });

  // Parse signature into r, s, v components
  const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
  const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
  const v = parseInt(signature.slice(130, 132), 16);

  return { v, r, s };
}

/**
 * Encode the permit function call
 */
function encodePermitCall(
  owner: Address,
  spender: Address,
  value: bigint,
  deadline: bigint,
  v: number,
  r: `0x${string}`,
  s: `0x${string}`
): `0x${string}` {
  return encodeFunctionData({
    abi: PERMIT_ABI,
    functionName: "permit",
    args: [owner, spender, value, deadline, v, r, s],
  });
}

/**
 * Build appData with permit pre-hook and auto slippage configuration
 *
 * COWSwap uses appData to include:
 * - Pre-transaction hooks (like permits)
 * - Order class (market vs limit)
 * - Quote metadata including slippage settings
 *
 * Setting smartSlippage: true enables COWSwap's auto slippage feature
 * where solvers can optimize execution within the slippage tolerance.
 *
 * The appDataHex is the keccak256 hash of the deterministically-stringified JSON.
 */
async function buildAppDataWithPermitHook(
  tokenAddress: TokenAddress,
  permitCalldata: `0x${string}`,
  slippageBps: number
): Promise<{ appDataHex: `0x${string}`; fullAppData: string }> {
  // Build the appData document following COW Protocol appData schema v1.1.0
  const appDataDoc = {
    version: "1.1.0",
    appCode: "Rift TEE Swapper",
    metadata: {
      hooks: {
        pre: [
          {
            target: tokenAddress,
            callData: permitCalldata,
            gasLimit: "80000", // Permit calls typically use ~50k gas
          },
        ],
      },
      // Mark this as a market order (vs limit order)
      orderClass: {
        orderClass: "market",
      },
      // Include slippage settings for auto slippage
      quote: {
        slippageBips: slippageBps,
        smartSlippage: true,
      },
    },
  };

  // Stringify deterministically (sorted keys, no extra whitespace)
  const fullAppData = await stringifyDeterministic(appDataDoc);

  // Compute the keccak256 hash of the JSON string
  const appDataHex = keccak256(stringToHex(fullAppData));

  return {
    appDataHex,
    fullAppData,
  };
}

/**
 * Execute a swap for CBBTC using EIP-2612 permit
 *
 * This flow:
 * 1. Gets the permit nonce for the vault wallet
 * 2. Signs an EIP-2612 permit authorizing COW's vault relayer
 * 3. Encodes the permit call as a pre-hook
 * 4. Submits the order with the permit hook in appData
 * 5. The solver executes the permit before the swap
 *
 * @param swap - The swap record
 * @param sellAmount - The actual amount of CBBTC to sell (vault balance)
 * @param _client - Unused, kept for interface compatibility
 */
export async function executePermitFlow(
  swap: Swap,
  sellAmount: bigint,
  _client: PublicClient
): Promise<ExecutionResult> {
  const chainId = swap.chainId as SupportedChainId;

  // Derive the private key from the stored salt
  const vaultWallet = getVaultWalletFromSalt(swap.vaultSalt as `0x${string}`);
  const privateKey = vaultWallet.privateKey;
  const vaultAddress = swap.vaultAddress as Address;

  // Deserialize tokens from DB storage
  const sellToken = deserializeToken(swap.sellToken);
  const buyToken = deserializeToken(swap.buyToken);

  // Get token addresses
  // sellToken is always CBBTC (ERC20), buyToken can be ERC20 or native ETH
  const sellTokenAddress = getTokenAddress(sellToken);
  const buyTokenAddress = getTokenAddress(buyToken);

  console.log(`[PermitFlow] Starting permit flow for swap ${swap.swapId}`);
  console.log(`[PermitFlow] Vault wallet: ${vaultAddress}, amount: ${sellAmount}`);

  // Create public client for reading nonce
  const publicClient = getPublicClient(chainId);

  // Get the current nonce
  const nonce = await getPermitNonce(publicClient, sellTokenAddress, vaultAddress);
  console.log(`[PermitFlow] Current nonce: ${nonce}`);

  // Set deadline to max uint256 (never expires)
  const deadline = maxUint256;

  // Value to approve - use max uint256 for unlimited approval
  const value = maxUint256;

  // Sign the permit
  const { v, r, s } = await signPermit(
    chainId,
    sellTokenAddress,
    privateKey,
    vaultAddress,
    GPV2_VAULT_RELAYER as Address,
    value,
    nonce,
    deadline
  );

  console.log(`[PermitFlow] Permit signed (v=${v})`);

  // Encode the permit call
  const permitCalldata = encodePermitCall(
    vaultAddress,
    GPV2_VAULT_RELAYER as Address,
    value,
    deadline,
    v,
    r,
    s
  );

  console.log(`[PermitFlow] Permit calldata: ${permitCalldata.slice(0, 66)}...`);

  // Fetch recommended slippage tolerance for this market
  const slippageBps = await getSlippageTolerance(
    chainId,
    sellTokenAddress,
    buyTokenAddress
  );
  console.log(`[PermitFlow] Using slippage tolerance: ${slippageBps} bps (${slippageBps / 100}%)`);

  // Build appData with the permit hook and slippage settings
  const { appDataHex, fullAppData } = await buildAppDataWithPermitHook(
    sellTokenAddress,
    permitCalldata,
    slippageBps
  );

  console.log(`[PermitFlow] AppData hash: ${appDataHex}`);

  // Get a fresh quote for the actual deposited amount
  const quote = await getQuote({
    chainId,
    sellToken,
    buyToken,
    sellAmount: sellAmount.toString(),
    from: vaultAddress,
  });

  // Apply slippage to get minimum acceptable buy amount
  const buyAmountMin = applySlippageToBuyAmount(quote.buyAmount, slippageBps);
  console.log(`[PermitFlow] Quote buyAmount: ${quote.buyAmount}, after slippage: ${buyAmountMin}`);

  // Create and submit the swap order with the permit hook in appData
  const order = await createSwapOrderWithAppData({
    chainId,
    sellToken: sellTokenAddress,
    buyToken: buyTokenAddress,
    sellAmount: quote.sellAmount,
    buyAmountMin,
    receiver: swap.recipientAddress as Address,
    vaultPrivateKey: privateKey,
    appDataHex,
    fullAppData,
  });

  console.log(`[PermitFlow] Order ${order.orderId} submitted with permit hook`);

  return {
    orderId: order.orderId,
    buyAmount: quote.buyAmount,
  };
}
