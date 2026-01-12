import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";

export interface DepositWallet {
  address: Address;
  privateKey: `0x${string}`;
}

/**
 * Generate a new one-time use deposit wallet
 */
export function createDepositWallet(): DepositWallet {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  
  return {
    address: account.address,
    privateKey,
  };
}

/**
 * Get account from private key (for signing transactions)
 */
export function getAccountFromPrivateKey(privateKey: `0x${string}`) {
  return privateKeyToAccount(privateKey);
}


