# TEE Swapper - Implementation Tasks

## 1. Swap Execution Logic (Core)

### 1.1 Token Type Detection
- [ ] Detect if `sellToken` is native ETH
- [ ] Detect if `sellToken` supports EIP-2612 permit
- [ ] Maintain whitelist of permit-supporting tokens OR detect dynamically

### 1.2 Native ETH Flow (EthFlow)
- [ ] Integrate with COWSwap's EthFlow contract (`0x40A50cf069e992AA4536211B23F286eF88752187`)
- [ ] Build and submit `createOrder` transaction with ETH value
- [ ] Handle gas estimation (some ETH used for tx, rest for swap)

### 1.3 ERC-20 with Permit Flow
- [ ] Sign EIP-2612 permit message off-chain
- [ ] Include permit in COWSwap order submission
- [ ] Handle tokens with non-standard permit (DAI uses different format)

### 1.4 Legacy ERC-20 Flow (No Permit)
- [ ] Hot wallet configuration (address + private key in env)
- [ ] Send ETH from hot wallet to deposit address for gas
- [ ] Send `approve()` transaction to GPv2VaultRelayer (`0xC92E8bdf79f0507f65a392b0ab4667716BFE0110`)
- [ ] Wait for approval confirmation
- [ ] Then submit COWSwap order

### 1.5 Order Settlement Tracking
- [ ] Poll COWSwap API for actual order status (filled/cancelled/expired)
- [ ] Update DB with actual fill amount
- [ ] Handle partial fills if applicable

---

## 2. Deposit Detection Improvements

### 2.1 Record Deposit Details
- [ ] When balance detected, query chain for the deposit transaction
- [ ] Extract `depositorAddress` from the tx
- [ ] Store `depositTxHash`, `depositAmount`, `depositorAddress` in DB

### 2.2 Multicall Optimization
- [ ] Use Multicall3's `getEthBalance()` for batched ETH balance queries

---

## 3. Refund Processor

- [ ] Create refund processor service
- [ ] Query for `refund_pending` swaps
- [ ] Send tokens/ETH back to `refundAddress`
- [ ] Handle gas for ERC-20 refunds (need ETH in deposit address)
- [ ] Mark as `refunded` with `refundTxHash` and `refundAmount`

---

## 4. Expiry Handler

- [ ] Periodic job to check swap expiry
- [ ] Expired swaps with deposits → mark as `refund_pending`
- [ ] Expired swaps without deposits → mark as `expired`

---

## 5. Error Handling & Resilience

- [ ] Retry logic for RPC failures
- [ ] Retry logic for COWSwap API failures
- [ ] Handle "order already exists" errors
- [ ] Handle insufficient liquidity errors
- [ ] Prevent double-execution (swap already executing)

---

## 6. Observability

- [ ] Add Prometheus metrics endpoint (`/metrics`)
- [ ] Metrics: swap counts by status, execution latency, error rates
- [ ] Metrics: pending deposit count per chain, balance check latency
- [ ] Add structured logging (replace `console.log`)

---

## 7. Configuration & Security

- [ ] Environment variable validation on startup
- [ ] Hot wallet address + private key config
- [ ] Database connection validation
- [ ] RPC health checks on startup

---

## 8. Database

- [ ] Generate Drizzle migrations (`bun run db:generate`)
- [ ] Test migration on fresh DB
- [ ] Add indexes for common query patterns

---

## Priority Guide

| Priority | Section | Rationale |
|----------|---------|-----------|
| **P0** | 1.2 Native ETH Flow | Simplest path to a working swap |
| **P0** | 1.5 Order Settlement Tracking | Must know if swap actually filled |
| **P1** | 1.3 Permit Flow | Covers USDC, DAI, most major tokens |
| **P1** | 2.1 Record Deposit Details | Required for refunds |
| **P2** | 1.4 Legacy ERC-20 Flow | Needed for non-permit tokens |
| **P2** | 4 Expiry Handler | Cleanup stale swaps |
| **P2** | 3 Refund Processor | Handle failures gracefully |
| **P3** | 5 Error Handling | Production hardening |
| **P3** | 6 Observability | Production monitoring |
| **P3** | 7 Configuration | Production readiness |

---

## Contract Addresses

| Contract | Mainnet | Base |
|----------|---------|------|
| GPv2VaultRelayer | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| EthFlow | `0x40A50cf069e992AA4536211B23F286eF88752187` | N/A (Base uses wrapped ETH) |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | `0xcA11bde05977b3631167028862bE2a173976CA11` |
