# syntax=docker/dockerfile:1

# Build stage - install dependencies
FROM oven/bun:1.2-alpine AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json bun.lock* ./

# Install all dependencies (including devDependencies for types)
RUN bun install --frozen-lockfile

# Copy source code and other necessary files
COPY src/ ./src/
COPY drizzle/ ./drizzle/
COPY drizzle.config.ts tsconfig.json ./

# Production stage - minimal runtime image
FROM oven/bun:1.2-alpine AS runtime

WORKDIR /app

# Install only production dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production && \
    rm -rf ~/.bun/install/cache

# Copy source and drizzle migrations from builder
COPY --from=builder /app/src ./src
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle.config.ts ./
COPY --from=builder /app/tsconfig.json ./

# Create non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Create config directory
RUN mkdir -p /app/config && chown appuser:appgroup /app/config

# Default environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose the port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

# Run as non-root user (can be overridden in compose for TEE environments)
USER appuser

# Start the server
CMD ["bun", "run", "src/index.ts"]
