import { keccak256, concat, toHex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";

/**
 * KeyDerivationService - Derives vault private keys from a server master key + salt
 *
 * This allows storing only the salt in the database, not the actual private key.
 * The server master key is stored in a local file and loaded into memory at startup.
 *
 * Security model:
 * - Database can be replicated to untrusted servers (only contains salts)
 * - Vault private keys can only be derived with access to the server master key
 * - Server master key should be stored securely (TEE sealed storage, HSM, etc.)
 *
 * Key derivation: vault_private_key = keccak256(server_key || salt)
 */
export class KeyDerivationService {
  private serverKey: `0x${string}`;

  /**
   * Create a new KeyDerivationService
   *
   * @param serverKeyPath - Path to file containing the server master key (64 hex chars, with or without 0x prefix)
   */
  constructor(serverKeyPath: string) {
    const keyContent = readFileSync(serverKeyPath, "utf-8").trim();

    // Normalize to 0x-prefixed format
    const normalizedKey = keyContent.startsWith("0x")
      ? keyContent
      : `0x${keyContent}`;

    // Validate it's a valid 32-byte hex string
    if (!/^0x[a-fA-F0-9]{64}$/.test(normalizedKey)) {
      throw new Error(
        "Invalid server key: must be 32 bytes (64 hex characters)"
      );
    }

    this.serverKey = normalizedKey as `0x${string}`;
    console.log("[KeyDerivation] Server key loaded");
  }

  /**
   * Derive a vault private key from a salt
   *
   * @param salt - 32-byte hex string (with 0x prefix)
   * @returns The derived private key
   */
  private derivePrivateKey(salt: `0x${string}`): `0x${string}` {
    // Concatenate server key and salt, then hash
    const combined = concat([this.serverKey, salt]);
    return keccak256(combined);
  }

  /**
   * Get a vault wallet from an existing salt
   *
   * @param salt - The salt stored in the database
   * @returns The vault wallet with address and derived private key
   */
  getVaultWallet(salt: `0x${string}`): {
    address: Address;
    privateKey: `0x${string}`;
  } {
    const privateKey = this.derivePrivateKey(salt);
    const account = privateKeyToAccount(privateKey);

    return {
      address: account.address,
      privateKey,
    };
  }

  /**
   * Create a new vault wallet with a random salt
   *
   * @returns The vault wallet with address, derived private key, and the salt to store
   */
  createVaultWallet(): {
    address: Address;
    privateKey: `0x${string}`;
    salt: `0x${string}`;
  } {
    // Generate 32 random bytes as salt
    const saltBytes = new Uint8Array(32);
    crypto.getRandomValues(saltBytes);
    const salt = toHex(saltBytes) as `0x${string}`;

    const privateKey = this.derivePrivateKey(salt);
    const account = privateKeyToAccount(privateKey);

    return {
      address: account.address,
      privateKey,
      salt,
    };
  }
}

// Singleton instance
let _keyDerivationService: KeyDerivationService | null = null;

/**
 * Initialize the KeyDerivationService singleton
 *
 * Reads the server key path from SERVER_KEY_PATH environment variable.
 * Must be called before any vault wallet operations.
 */
export function initKeyDerivation(): void {
  if (_keyDerivationService) {
    console.log("[KeyDerivation] Already initialized");
    return;
  }

  const serverKeyPath = process.env.SERVER_KEY_PATH;
  if (!serverKeyPath) {
    throw new Error(
      "SERVER_KEY_PATH environment variable is required"
    );
  }

  _keyDerivationService = new KeyDerivationService(serverKeyPath);
}

/**
 * Get the KeyDerivationService singleton
 *
 * @throws Error if not initialized
 */
export function getKeyDerivationService(): KeyDerivationService {
  if (!_keyDerivationService) {
    throw new Error(
      "KeyDerivationService not initialized. Call initKeyDerivation() first."
    );
  }
  return _keyDerivationService;
}

/**
 * Set a custom KeyDerivationService (for testing)
 */
export function setKeyDerivationService(
  service: KeyDerivationService | null
): void {
  _keyDerivationService = service;
}
