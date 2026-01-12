import type { Token, TokenAddress } from "../types";

/**
 * Serialize a Token to a string for database storage
 * - Native ETH: "native"
 * - ERC20: the address itself (0x...)
 */
export function serializeToken(token: Token): string {
  if (token.type === "native") {
    return "native";
  }
  return token.address;
}

/**
 * Deserialize a string from database to Token
 * - "native" -> { type: "native" }
 * - 0x... -> { type: "erc20", address: ... }
 */
export function deserializeToken(serialized: string): Token {
  if (serialized === "native") {
    return { type: "native" };
  }
  return { type: "erc20", address: serialized as TokenAddress };
}
