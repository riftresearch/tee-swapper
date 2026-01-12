# TEE Swapper

A TypeScript server for executing token swaps via COWSwap, designed to run in a Trusted Execution Environment (TEE). Creates one-time use deposit addresses for trustless, non-custodial swaps.

## Quick Start

```bash
# Install dependencies
bun install

# Start the database
bun run db:up

# Push the schema to the database
DATABASE_URL=postgres://tee_swapper:tee_swapper_dev@localhost:5432/tee_swapper bun run db:push

# Start the development server
DATABASE_URL=postgres://tee_swapper:tee_swapper_dev@localhost:5432/tee_swapper bun run dev
```

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start development server with hot reload |
| `bun run start` | Start production server |
| `bun run test` | Run tests (skips DB tests if no DATABASE_URL) |
| `bun run test:db` | Run all tests including database tests |
| `bun run db:up` | Start PostgreSQL via Docker |
| `bun run db:down` | Stop PostgreSQL |
| `bun run db:push` | Push schema to database |
| `bun run db:generate` | Generate migrations |
| `bun run db:migrate` | Run migrations |

## API Endpoints

### Health Check
```
GET /health
```

### Get Quote
```
POST /quote
{
  "chainId": 1,
  "sellToken": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "buyToken": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  "sellAmount": "1000000000"
}
```

### Create Swap
```
POST /swap
{
  "chainId": 1,
  "sellToken": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "buyToken": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  "sellAmount": "1000000000",
  "recipientAddress": "0x...",
  "refundAddress": "0x..."
}
```

### Get Swap Status
```
GET /swap/:id
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `ETH_RPC_URL` | Ethereum RPC URL | `https://eth.drpc.org` |
| `BASE_RPC_URL` | Base RPC URL | `https://base.drpc.org` |
| `PORT` | Server port | `3000` |

## Testing

```bash
# Run validation tests only (no database required)
bun test

# Run all tests with database
bun run db:up
bun run test:db
```

## Architecture

See `TODO.md` for remaining implementation tasks.
