import { type Token, type TokenAddress, NATIVE_ETH_ADDRESS, getTokenAddress } from "../types";

/**
 * Serialize a Token to a string for database storage
 * ERC20 tokens are stored as their address
 * Native ETH is stored as the sentinel address
 */
export function serializeToken(token: Token): string {
  return getTokenAddress(token);
}

/**
 * Deserialize a string from database to Token
 * Checks for native ETH sentinel address
 */
export function deserializeToken(serialized: string): Token {
  // Check if it's the native ETH sentinel address (case-insensitive)
  if (serialized.toLowerCase() === NATIVE_ETH_ADDRESS.toLowerCase()) {
    return { type: "ether" };
  }
  return { type: "erc20", address: serialized as TokenAddress };
}
