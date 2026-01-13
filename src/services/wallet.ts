import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { getKeyDerivationService } from "./key-derivation";

export interface VaultWallet {
  address: Address;
  privateKey: `0x${string}`;
  salt: `0x${string}`;
}

/**
 * Generate a new one-time use vault wallet using key derivation
 *
 * Returns the address, derived private key, and the salt to store in DB.
 * Only the salt should be stored - private key is derived at runtime.
 */
export function createVaultWallet(): VaultWallet {
  const keyService = getKeyDerivationService();
  return keyService.createVaultWallet();
}

/**
 * Get a vault wallet from a stored salt
 *
 * @param salt - The salt stored in the database
 * @returns The vault wallet with address and derived private key
 */
export function getVaultWalletFromSalt(salt: `0x${string}`): {
  address: Address;
  privateKey: `0x${string}`;
} {
  const keyService = getKeyDerivationService();
  return keyService.getVaultWallet(salt);
}

/**
 * Get account from private key (for signing transactions)
 */
export function getAccountFromPrivateKey(privateKey: `0x${string}`) {
  return privateKeyToAccount(privateKey);
}


