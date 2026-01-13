#!/usr/bin/env bun
/**
 * Recovery script for stuck funds in deposit vaults
 *
 * This script:
 * 1. Scans all deposit vaults in the test database
 * 2. Checks balances of CBBTC, USDC, USDT on Base chain
 * 3. Recovers any stuck funds back to the test wallet
 *
 * Usage:
 *   bun scripts/recover-funds.ts                    # Dry run - show what would be recovered
 *   bun scripts/recover-funds.ts --limit 2          # Dry run - only process 2 vaults
 *   bun scripts/recover-funds.ts --execute          # Execute recovery for all vaults
 *   bun scripts/recover-funds.ts --execute --limit 1 # Execute recovery for 1 vault only
 *
 * Requires:
 *   - SERVER_KEY_PATH env var pointing to the server master key file
 */

import { PGlite } from "@electric-sql/pglite";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  erc20Abi,
  type Address,
  type PublicClient,
  type WalletClient,
  type Account,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { KeyDerivationService } from "../src/services/key-derivation";

// Configuration
const DATA_DIR = "./test-data/pglite";
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://base.drpc.org";
const TEST_PRIVATE_KEY = process.env.TEST_PRIVATE_KEY;
const SERVER_KEY_PATH = process.env.SERVER_KEY_PATH;

// Base chain tokens
const TOKENS = {
  CBBTC: {
    address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as Address,
    decimals: 8,
    symbol: "CBBTC",
  },
  USDC: {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
    decimals: 6,
    symbol: "USDC",
  },
  USDT: {
    address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" as Address,
    decimals: 6,
    symbol: "USDT",
  },
} as const;

// Gas estimates
const ETH_TRANSFER_GAS = 21000n;
const ERC20_TRANSFER_GAS = 65000n; // Typical ERC20 transfer gas

interface VaultInfo {
  vaultAddress: Address;
  vaultSalt: `0x${string}`;
  swapId: string;
  status: string;
  chainId: number;
}

interface VaultBalance {
  vault: VaultInfo;
  ethBalance: bigint;
  cbbtcBalance: bigint;
  usdcBalance: bigint;
  usdtBalance: bigint;
}

interface RecoveryAction {
  vault: VaultInfo;
  token: "ETH" | "CBBTC" | "USDC" | "USDT";
  amount: bigint;
  amountFormatted: string;
  needsGasFunding: boolean;
  gasFundingNeeded: bigint;
}

interface SwapRow {
  vault_address: string;
  vault_salt: string;
  swap_id: string;
  status: string;
  chain_id: number;
}

async function getVaultsFromDatabase(): Promise<VaultInfo[]> {
  const client = new PGlite(DATA_DIR);

  try {
    const result = await client.query<SwapRow>(`
      SELECT
        vault_address,
        vault_salt,
        swap_id,
        status,
        chain_id
      FROM swaps
      ORDER BY created_at DESC
    `);

    return result.rows.map((row) => ({
      vaultAddress: row.vault_address as Address,
      vaultSalt: row.vault_salt as `0x${string}`,
      swapId: row.swap_id,
      status: row.status,
      chainId: row.chain_id,
    }));
  } finally {
    await client.close();
  }
}

async function checkVaultBalances(
  vaults: VaultInfo[],
  publicClient: PublicClient
): Promise<VaultBalance[]> {
  const balances: VaultBalance[] = [];

  for (const vault of vaults) {
    // Only check Base chain vaults (chainId 8453)
    if (vault.chainId !== 8453) {
      console.log(`Skipping vault ${vault.vaultAddress} - chain ${vault.chainId} not Base`);
      continue;
    }

    const [ethBalance, cbbtcBalance, usdcBalance, usdtBalance] = await Promise.all([
      publicClient.getBalance({ address: vault.vaultAddress }),
      publicClient.readContract({
        address: TOKENS.CBBTC.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault.vaultAddress],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: TOKENS.USDC.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault.vaultAddress],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: TOKENS.USDT.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault.vaultAddress],
      }) as Promise<bigint>,
    ]);

    balances.push({
      vault,
      ethBalance,
      cbbtcBalance,
      usdcBalance,
      usdtBalance,
    });
  }

  return balances;
}

function planRecoveryActions(
  balances: VaultBalance[],
  maxFeePerGas: bigint
): RecoveryAction[] {
  const actions: RecoveryAction[] = [];

  for (const { vault, ethBalance, cbbtcBalance, usdcBalance, usdtBalance } of balances) {
    // Calculate gas costs using maxFeePerGas (worst case)
    const ethTransferCost = ETH_TRANSFER_GAS * maxFeePerGas;
    const erc20TransferCost = ERC20_TRANSFER_GAS * maxFeePerGas;

    // Calculate total gas needed for all ERC20 transfers in this vault
    const numErc20Transfers =
      (cbbtcBalance > 0n ? 1n : 0n) +
      (usdcBalance > 0n ? 1n : 0n) +
      (usdtBalance > 0n ? 1n : 0n);
    const totalErc20GasNeeded = erc20TransferCost * numErc20Transfers;

    const needsGasFunding = numErc20Transfers > 0n && ethBalance < totalErc20GasNeeded;
    const gasFundingNeeded = needsGasFunding ? totalErc20GasNeeded - ethBalance : 0n;

    // Check CBBTC (primary token for this project)
    if (cbbtcBalance > 0n) {
      actions.push({
        vault,
        token: "CBBTC",
        amount: cbbtcBalance,
        amountFormatted: formatUnits(cbbtcBalance, TOKENS.CBBTC.decimals),
        needsGasFunding,
        gasFundingNeeded,
      });
    }

    // Check USDC
    if (usdcBalance > 0n) {
      actions.push({
        vault,
        token: "USDC",
        amount: usdcBalance,
        amountFormatted: formatUnits(usdcBalance, TOKENS.USDC.decimals),
        needsGasFunding,
        gasFundingNeeded,
      });
    }

    // Check USDT
    if (usdtBalance > 0n) {
      actions.push({
        vault,
        token: "USDT",
        amount: usdtBalance,
        amountFormatted: formatUnits(usdtBalance, TOKENS.USDT.decimals),
        needsGasFunding,
        gasFundingNeeded,
      });
    }

    // Check ETH (only recover if value > gas cost, otherwise it's dust)
    // We recover ETH last because we might need it for ERC20 transfers
    const ethNeededForErc20 =
      (cbbtcBalance > 0n ? erc20TransferCost : 0n) +
      (usdcBalance > 0n ? erc20TransferCost : 0n) +
      (usdtBalance > 0n ? erc20TransferCost : 0n);
    const ethRecoverable = ethBalance - ethNeededForErc20 - ethTransferCost;

    // Only recover if the amount we'd get is more than the gas cost to get it
    // (i.e., it's not worth paying more in gas than we'd receive)
    if (ethRecoverable > ethTransferCost) {
      actions.push({
        vault,
        token: "ETH",
        amount: ethRecoverable,
        amountFormatted: formatUnits(ethRecoverable, 18),
        needsGasFunding: false,
        gasFundingNeeded: 0n,
      });
    }
  }

  return actions;
}

async function executeRecovery(
  actions: RecoveryAction[],
  recoveryAddress: Address,
  fundingAccount: Account,
  publicClient: PublicClient,
  keyDerivationService: KeyDerivationService
): Promise<void> {
  // Create wallet client for the funding account
  const fundingWallet = createWalletClient({
    account: fundingAccount,
    chain: base,
    transport: http(BASE_RPC_URL),
  });
  // Get current EIP-1559 fee estimates from the network
  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;

  // Group actions by vault to handle gas funding efficiently
  const vaultActions = new Map<string, RecoveryAction[]>();
  for (const action of actions) {
    const key = action.vault.vaultAddress;
    if (!vaultActions.has(key)) {
      vaultActions.set(key, []);
    }
    vaultActions.get(key)!.push(action);
  }

  for (const [vaultAddress, vaultActionList] of vaultActions) {
    const vault = vaultActionList[0]!.vault;
    console.log(`\nProcessing vault: ${vaultAddress}`);

    // Check if we need to fund gas
    const maxGasFundingNeeded = vaultActionList.reduce(
      (max, a) => (a.gasFundingNeeded > max ? a.gasFundingNeeded : max),
      0n
    );

    if (maxGasFundingNeeded > 0n) {
      console.log(`  Sending ${formatUnits(maxGasFundingNeeded, 18)} ETH for gas...`);

      const fundingTxHash = await fundingWallet.sendTransaction({
        to: vaultAddress as Address,
        value: maxGasFundingNeeded,
        chain: base,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });

      console.log(`  Gas funding tx: ${fundingTxHash}`);
      await publicClient.waitForTransactionReceipt({ hash: fundingTxHash, confirmations: 3 });
      console.log(`  Gas funding confirmed (3 blocks)`);

      // Verify the vault actually has the ETH before proceeding
      const vaultBalance = await publicClient.getBalance({ address: vaultAddress as Address });
      console.log(`  Vault balance after funding: ${formatUnits(vaultBalance, 18)} ETH`);
    }

    // Derive private key from salt and create wallet client for the vault
    const { privateKey } = keyDerivationService.getVaultWallet(vault.vaultSalt);
    const vaultAccount = privateKeyToAccount(privateKey);
    const vaultWallet = createWalletClient({
      account: vaultAccount,
      chain: base,
      transport: http(BASE_RPC_URL),
    });

    // Execute ERC20 transfers first
    for (const action of vaultActionList.filter(a => a.token !== "ETH")) {
      const tokenInfo =
        action.token === "CBBTC" ? TOKENS.CBBTC :
        action.token === "USDC" ? TOKENS.USDC : TOKENS.USDT;
      console.log(`  Transferring ${action.amountFormatted} ${action.token}...`);

      try {
        const txHash = await vaultWallet.writeContract({
          address: tokenInfo.address,
          abi: erc20Abi,
          functionName: "transfer",
          args: [recoveryAddress, action.amount],
          chain: base,
          maxFeePerGas,
          maxPriorityFeePerGas,
        });

        console.log(`  ${action.token} tx: ${txHash}`);
        await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 3 });
        console.log(`  ${action.token} transfer confirmed (3 blocks)`);
      } catch (error) {
        console.error(`  Failed to transfer ${action.token}:`, error);
      }
    }

    // Execute ETH transfer last (send remaining balance minus gas)
    const ethAction = vaultActionList.find(a => a.token === "ETH");
    if (ethAction) {
      // Get current balance to send everything minus gas
      const currentBalance = await publicClient.getBalance({ address: vaultAddress as Address });
      const estimatedGasCost = ETH_TRANSFER_GAS * maxFeePerGas;
      let amountToSend = currentBalance - estimatedGasCost;

      // Skip if amount to send is less than gas cost (dust)
      if (amountToSend <= estimatedGasCost) {
        console.log(`  Skipping ETH transfer: amount (${formatUnits(amountToSend, 18)}) <= gas cost (${formatUnits(estimatedGasCost, 18)})`);
      } else if (amountToSend > 0n) {
        console.log(`  Transferring ${formatUnits(amountToSend, 18)} ETH...`);

        try {
          const txHash = await vaultWallet.sendTransaction({
            to: recoveryAddress,
            value: amountToSend,
            chain: base,
            maxFeePerGas,
            maxPriorityFeePerGas,
          });

          console.log(`  ETH tx: ${txHash}`);
          await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 3 });
          console.log(`  ETH transfer confirmed (3 blocks)`);
        } catch (error) {
          // Check if it's an insufficient funds error - if so, parse and retry with exact amount
          const errorStr = String(error);

          // Try different error formats
          // Format 1: "have X want Y"
          // Format 2: "balance X, tx cost Y, overshot Z"
          const matchHaveWant = errorStr.match(/have (\d+) want (\d+)/);
          const matchOvershot = errorStr.match(/balance (\d+), tx cost (\d+), overshot (\d+)/);

          let correctedAmount: bigint | null = null;
          let actualGasCost: bigint | null = null;

          if (matchOvershot) {
            // Use overshot directly - it's exactly how much we need to subtract
            const overshot = BigInt(matchOvershot[3]!);
            correctedAmount = amountToSend - overshot;
            actualGasCost = BigInt(matchOvershot[2]!) - amountToSend; // tx cost - value = gas cost
          } else if (matchHaveWant) {
            const have = BigInt(matchHaveWant[1]!);
            const want = BigInt(matchHaveWant[2]!);
            actualGasCost = want - amountToSend;
            correctedAmount = have - actualGasCost;
          }

          if (correctedAmount !== null && actualGasCost !== null) {

            if (correctedAmount > 0n) {
              console.log(`  Retrying with corrected amount: ${formatUnits(correctedAmount, 18)} ETH`);
              console.log(`  (actual gas cost: ${formatUnits(actualGasCost, 18)} ETH)`);

              try {
                const txHash = await vaultWallet.sendTransaction({
                  to: recoveryAddress,
                  value: correctedAmount,
                  chain: base,
                  maxFeePerGas,
                  maxPriorityFeePerGas,
                });

                console.log(`  ETH tx: ${txHash}`);
                await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 3 });
                console.log(`  ETH transfer confirmed (3 blocks)`);
              } catch (retryError) {
                console.error(`  Failed to transfer ETH on retry:`, retryError);
              }
            } else {
              console.log(`  Corrected amount is <= 0, skipping ETH transfer`);
            }
          } else {
            console.error(`  Failed to transfer ETH:`, error);
          }
        }
      }
    }
  }
}

async function main() {
  const execute = process.argv.includes("--execute");

  // Parse --limit N parameter
  const limitIndex = process.argv.findIndex(arg => arg === "--limit");
  const limitArg = limitIndex !== -1 ? process.argv[limitIndex + 1] : undefined;
  const limit = limitArg !== undefined ? parseInt(limitArg, 10) : undefined;

  console.log("=".repeat(60));
  console.log("Deposit Vault Recovery Script");
  console.log("=".repeat(60));
  console.log(`Mode: ${execute ? "EXECUTE" : "DRY RUN"}`);
  if (limit !== undefined) {
    console.log(`Limit: ${limit} vault(s)`);
  }
  console.log();

  // Validate environment
  if (!TEST_PRIVATE_KEY) {
    console.error("ERROR: TEST_PRIVATE_KEY not set in environment");
    console.error("Please set it in .env file");
    process.exit(1);
  }

  if (!SERVER_KEY_PATH) {
    console.error("ERROR: SERVER_KEY_PATH not set in environment");
    console.error("Please set it in .env file (path to server master key file)");
    process.exit(1);
  }

  // Initialize key derivation service
  const keyDerivationService = new KeyDerivationService(SERVER_KEY_PATH);
  console.log(`Server key loaded from: ${SERVER_KEY_PATH}`);

  // Set up clients
  const recoveryAccount = privateKeyToAccount(TEST_PRIVATE_KEY as `0x${string}`);
  const recoveryAddress = recoveryAccount.address;

  console.log(`Recovery address: ${recoveryAddress}`);
  console.log(`RPC URL: ${BASE_RPC_URL}`);
  console.log();

  const publicClient = createPublicClient({
    chain: base,
    transport: http(BASE_RPC_URL),
  });

  // Get vaults from database
  console.log("Fetching vaults from database...");
  const vaults = await getVaultsFromDatabase();
  console.log(`Found ${vaults.length} vaults`);
  console.log();

  // Check balances
  console.log("Checking vault balances...");
  const balances = await checkVaultBalances(vaults, publicClient as PublicClient);

  // Filter to vaults with non-zero balances
  let vaultsWithFunds = balances.filter(
    b => b.ethBalance > 0n || b.cbbtcBalance > 0n || b.usdcBalance > 0n || b.usdtBalance > 0n
  );

  if (vaultsWithFunds.length === 0) {
    console.log("\nNo vaults with recoverable funds found.");
    process.exit(0);
  }

  // Apply limit if specified
  if (limit !== undefined && limit > 0) {
    vaultsWithFunds = vaultsWithFunds.slice(0, limit);
  }

  // Display balances
  console.log("\n" + "=".repeat(60));
  console.log(`Vaults with funds: ${vaultsWithFunds.length}${limit !== undefined ? ` (limited from ${balances.filter(b => b.ethBalance > 0n || b.cbbtcBalance > 0n || b.usdcBalance > 0n || b.usdtBalance > 0n).length})` : ""}`);
  console.log("=".repeat(60));

  for (const { vault, ethBalance, cbbtcBalance, usdcBalance, usdtBalance } of vaultsWithFunds) {
    console.log(`\nVault: ${vault.vaultAddress}`);
    console.log(`  Swap ID: ${vault.swapId}`);
    console.log(`  Status: ${vault.status}`);
    if (ethBalance > 0n) {
      console.log(`  ETH:   ${formatUnits(ethBalance, 18)}`);
    }
    if (cbbtcBalance > 0n) {
      console.log(`  CBBTC: ${formatUnits(cbbtcBalance, 8)}`);
    }
    if (usdcBalance > 0n) {
      console.log(`  USDC:  ${formatUnits(usdcBalance, 6)}`);
    }
    if (usdtBalance > 0n) {
      console.log(`  USDT:  ${formatUnits(usdtBalance, 6)}`);
    }
  }

  // Get EIP-1559 fee estimates from the network
  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  console.log(`\nNetwork fees (EIP-1559):`);
  console.log(`  maxFeePerGas: ${formatUnits(maxFeePerGas, 9)} gwei`);
  console.log(`  maxPriorityFeePerGas: ${formatUnits(maxPriorityFeePerGas, 9)} gwei`);

  const actions = planRecoveryActions(vaultsWithFunds, maxFeePerGas);

  if (actions.length === 0) {
    console.log("\nNo recoverable funds (balances too small to cover gas).");
    process.exit(0);
  }

  // Display recovery plan
  console.log("\n" + "=".repeat(60));
  console.log("Recovery Plan:");
  console.log("=".repeat(60));

  // Track gas funding per vault (to avoid double-counting when vault has multiple tokens)
  const vaultGasFunding = new Map<string, bigint>();
  for (const action of actions) {
    console.log(`\n${action.token}: ${action.amountFormatted}`);
    console.log(`  From: ${action.vault.vaultAddress}`);
    if (action.needsGasFunding) {
      console.log(`  ⚠ Needs gas funding: ${formatUnits(action.gasFundingNeeded, 18)} ETH`);
      // Only count once per vault (take max in case values differ)
      const current = vaultGasFunding.get(action.vault.vaultAddress) || 0n;
      if (action.gasFundingNeeded > current) {
        vaultGasFunding.set(action.vault.vaultAddress, action.gasFundingNeeded);
      }
    }
  }

  let totalGasFundingNeeded = 0n;
  for (const amount of vaultGasFunding.values()) {
    totalGasFundingNeeded += amount;
  }

  if (totalGasFundingNeeded > 0n) {
    console.log(`\nTotal gas funding needed: ${formatUnits(totalGasFundingNeeded, 18)} ETH`);

    // Check if recovery wallet has enough
    const recoveryBalance = await publicClient.getBalance({ address: recoveryAddress });
    console.log(`Recovery wallet balance: ${formatUnits(recoveryBalance, 18)} ETH`);

    if (recoveryBalance < totalGasFundingNeeded) {
      console.error("\nERROR: Insufficient ETH in recovery wallet for gas funding");
      process.exit(1);
    }
  }

  // Execute or exit
  if (!execute) {
    console.log("\n" + "=".repeat(60));
    console.log("DRY RUN COMPLETE");
    console.log("Run with --execute to perform actual recovery");
    console.log("=".repeat(60));
    process.exit(0);
  }

  console.log("\n" + "=".repeat(60));
  console.log("EXECUTING RECOVERY...");
  console.log("=".repeat(60));

  await executeRecovery(
    actions,
    recoveryAddress,
    recoveryAccount,
    publicClient as PublicClient,
    keyDerivationService
  );

  console.log("\n" + "=".repeat(60));
  console.log("RECOVERY COMPLETE");
  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error("Recovery failed:", error);
  process.exit(1);
});
