import { type Address, type PublicClient, keccak256, stringToHex } from "viem";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Wallet } from "@ethersproject/wallet";
import { Eip2612PermitUtils } from "@1inch/permit-signed-approvals-utils";
import {
  generatePermitHook,
  getTokenPermitInfo,
  isSupportedPermitInfo,
  type PermitHookData,
  type PermitInfo,
} from "@cowprotocol/permit-utils";
import { stringifyDeterministic } from "@cowprotocol/sdk-app-data";
import type { Swap } from "../../db/schema";
import type { ExecutionResult, SupportedChainId, TokenAddress, Token } from "../../types";
import { isNativeToken } from "../../types";
import { deserializeToken } from "../../utils/token";
import { createSwapOrderWithAppData, getQuote } from "../cowswap";
import { GPV2_VAULT_RELAYER } from "../tokens";
import { chains } from "../../config/chains";

// WETH addresses per chain - for converting native ETH buyToken to WETH for orders
const WETH_BY_CHAIN: Record<SupportedChainId, TokenAddress> = {
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as TokenAddress,
  8453: "0x4200000000000000000000000000000000000006" as TokenAddress,
};

/**
 * Convert Token to TokenAddress for order submission
 * Native ETH is converted to WETH since COWSwap orders use WETH
 */
function tokenToOrderAddress(token: Token, chainId: SupportedChainId): TokenAddress {
  if (isNativeToken(token)) {
    return WETH_BY_CHAIN[chainId];
  }
  return token.address;
}

/**
 * Custom ProviderConnector that uses our wallet for signing
 * This implements the interface expected by @1inch/permit-signed-approvals-utils
 */
class WalletProviderConnector {
  private provider: JsonRpcProvider;
  private wallet: Wallet;

  constructor(provider: JsonRpcProvider, wallet: Wallet) {
    this.provider = provider;
    this.wallet = wallet.connect(provider);
  }

  contractEncodeABI(
    abi: Array<{ name: string; type: string; inputs?: Array<{ name: string; type: string }> }>,
    address: string | null,
    methodName: string,
    methodParams: unknown[]
  ): string {
    const { Contract } = require("@ethersproject/contracts");
    const contract = new Contract(address || "", abi, this.provider);
    return contract.interface.encodeFunctionData(methodName, methodParams);
  }

  async signTypedData(
    _walletAddress: string,
    typedData: { domain: object; types: Record<string, Array<{ name: string; type: string }>>; message: object },
    _typedDataHash: string
  ): Promise<string> {
    // Remove EIP712Domain from types as ethers adds it automatically
    const types: Record<string, Array<{ name: string; type: string }>> = {};
    for (const key of Object.keys(typedData.types)) {
      if (key !== "EIP712Domain") {
        const typeArray = typedData.types[key];
        if (typeArray) {
          types[key] = typeArray;
        }
      }
    }

    return this.wallet._signTypedData(typedData.domain, types, typedData.message);
  }

  async ethCall(contractAddress: string, callData: string): Promise<string> {
    return this.provider.call({
      to: contractAddress,
      data: callData,
    });
  }

  decodeABIParameter<T>(type: string, hex: string): T {
    const { defaultAbiCoder } = require("@ethersproject/abi");
    return defaultAbiCoder.decode([type], hex)[0] as T;
  }

  decodeABIParameters<T>(types: Array<{ name: string; type: string }>, hex: string): T {
    const { defaultAbiCoder } = require("@ethersproject/abi");
    const decoded = defaultAbiCoder.decode(types, hex);
    const result: Record<string, unknown> = {};
    Object.keys(decoded).forEach((key) => {
      const value = decoded[key];
      // Convert BigNumber to hex string
      if (value && typeof value === "object" && "_isBigNumber" in value) {
        result[key] = value.toHexString();
      } else {
        result[key] = value;
      }
    });
    return result as T;
  }
}

/**
 * Create provider and wallet for permit operations
 */
function createProviderAndWallet(
  chainId: SupportedChainId,
  privateKey: `0x${string}`
): { provider: JsonRpcProvider; wallet: Wallet; connector: WalletProviderConnector } {
  const chainConfig = chains[chainId];
  const provider = new JsonRpcProvider(chainConfig.rpcUrl);
  const wallet = new Wallet(privateKey);
  const connector = new WalletProviderConnector(provider, wallet);
  return { provider, wallet: wallet.connect(provider), connector };
}

/**
 * Get permit info for a token, detecting if it supports permits
 */
async function getPermitInfoForToken(
  chainId: SupportedChainId,
  tokenAddress: TokenAddress,
  provider: JsonRpcProvider
): Promise<PermitInfo | null> {
  const result = await getTokenPermitInfo({
    spender: GPV2_VAULT_RELAYER,
    tokenAddress,
    chainId,
    provider,
  });

  // Check if it's an error result
  if ("error" in result) {
    console.log(`[PermitFlow] Token ${tokenAddress} permit check failed: ${result.error}`);
    return null;
  }

  if (!isSupportedPermitInfo(result)) {
    console.log(`[PermitFlow] Token ${tokenAddress} does not support permits`);
    return null;
  }

  return result;
}

/**
 * Generate permit hook using COW Protocol's permit-utils library
 */
async function generatePermitHookData(
  chainId: SupportedChainId,
  tokenAddress: TokenAddress,
  tokenName: string | undefined,
  provider: JsonRpcProvider,
  wallet: Wallet,
  connector: WalletProviderConnector,
  permitInfo: PermitInfo
): Promise<PermitHookData> {
  // Create permit utils instance with our custom connector
  const eip2612Utils = new Eip2612PermitUtils(connector);

  // Get current nonce
  const nonce = await eip2612Utils.getTokenNonce(tokenAddress, wallet.address);

  // Generate the permit hook
  const hookData = await generatePermitHook({
    inputToken: { address: tokenAddress, name: tokenName },
    spender: GPV2_VAULT_RELAYER,
    chainId,
    permitInfo,
    provider,
    eip2612Utils,
    account: wallet.address,
    nonce,
  });

  if (!hookData) {
    throw new Error(`Failed to generate permit hook for token ${tokenAddress}`);
  }

  return hookData;
}

/**
 * Build appData with permit pre-hook
 *
 * This computes the appData hash locally without needing external APIs.
 * The appDataHex is the keccak256 hash of the deterministically-stringified JSON.
 */
async function buildAppDataWithPermitHook(
  hookData: PermitHookData
): Promise<{ appDataHex: `0x${string}`; fullAppData: string }> {
  // Build the appData document with the permit pre-hook
  // Following COW Protocol appData schema v1.1.0
  const appDataDoc = {
    version: "1.1.0",
    appCode: "Rift TEE Swapper",
    metadata: {
      hooks: {
        pre: [hookData],
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
 * Execute a swap for an ERC-20 token with permit support
 *
 * This flow uses COW Protocol's permit-utils library to:
 * 1. Detect if the token supports permits (EIP-2612 or DAI-style)
 * 2. Sign the permit with our deposit wallet
 * 3. Generate the permit hook calldata
 * 4. Submit the order with the permit hook in appData
 * 5. The solver executes the permit before the swap
 */
export async function executePermitFlow(
  swap: Swap,
  _permitConfig: unknown, // Deprecated - we now detect permit info dynamically
  _client: PublicClient
): Promise<ExecutionResult> {
  const chainId = swap.chainId as SupportedChainId;
  const privateKey = swap.depositPrivateKey as `0x${string}`;

  // Deserialize tokens from DB storage
  const sellToken = deserializeToken(swap.sellToken);
  const buyToken = deserializeToken(swap.buyToken);

  // Validate sellToken is an ERC20 (not native ETH)
  // Native ETH cannot use the permit flow - it would go through EthFlow
  if (isNativeToken(sellToken)) {
    throw new Error("Cannot use permit flow for native ETH - use EthFlow instead");
  }
  const sellTokenAddress = sellToken.address;

  // Convert buyToken to address for the order (native ETH -> WETH)
  const buyTokenAddress = tokenToOrderAddress(buyToken, chainId);

  console.log(`[PermitFlow] Starting permit flow for swap ${swap.swapId}`);

  // Create provider with our wallet
  const { provider, wallet, connector } = createProviderAndWallet(chainId, privateKey);

  console.log(`[PermitFlow] Deposit wallet: ${wallet.address}`);

  // Get permit info for the token
  const permitInfo = await getPermitInfoForToken(chainId, sellTokenAddress, provider);

  if (!permitInfo) {
    throw new Error(`Token ${sellTokenAddress} does not support permits`);
  }

  console.log(`[PermitFlow] Token supports ${permitInfo.type} permits (name: ${permitInfo.name}, version: ${permitInfo.version})`);

  // Generate the permit hook
  const hookData = await generatePermitHookData(
    chainId,
    sellTokenAddress,
    permitInfo.name,
    provider,
    wallet,
    connector,
    permitInfo
  );

  console.log(`[PermitFlow] Generated permit hook: target=${hookData.target}, gasLimit=${hookData.gasLimit}`);

  // Build appData with the permit hook
  const { appDataHex, fullAppData } = await buildAppDataWithPermitHook(hookData);

  console.log(`[PermitFlow] AppData hash: ${appDataHex}`);

  // Get a fresh quote
  // Note: getQuote accepts Token and converts native ETH to WETH internally
  const quote = await getQuote({
    chainId,
    sellToken, // Pass Token object - getQuote handles conversion
    buyToken,  // Pass Token object - getQuote handles conversion
    sellAmount: swap.expectedAmount,
    from: swap.depositAddress as Address,
  });

  // Create and submit the swap order with the permit hook in appData
  // Note: Order uses WETH address for buyToken if user wanted ETH
  const order = await createSwapOrderWithAppData({
    chainId,
    sellToken: sellTokenAddress,
    buyToken: buyTokenAddress, // Use WETH if buyToken was "ETH"
    sellAmount: quote.sellAmount,
    buyAmountMin: quote.buyAmount,
    receiver: swap.recipientAddress as Address,
    depositPrivateKey: privateKey,
    appDataHex,
    fullAppData,
  });

  console.log(`[PermitFlow] Order ${order.orderId} submitted with permit hook`);

  return {
    orderId: order.orderId,
    buyAmount: quote.buyAmount,
  };
}
