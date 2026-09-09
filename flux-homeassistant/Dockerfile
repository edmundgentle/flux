# ==========================================
# 1. Builder Stage
# ==========================================
FROM rust:1.88-slim-bookworm AS builder

# Install system build dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    git \
    clang \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Copy cargo manifest files
COPY Cargo.toml Cargo.lock ./

# Create dummy source file to compile dependencies first (for layer caching)
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release
RUN rm -rf src

# Copy actual source files
COPY src ./src

# Build the release binary
RUN cargo build --release

# ==========================================
# 2. Runner Stage
# ==========================================
FROM debian:bookworm-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy binary from builder
COPY --from=builder /usr/src/app/target/release/flux-homeassistant /app/server

# Expose port
EXPOSE 8080

# Environment variables
ENV RUST_LOG=info

# Start the application
CMD ["/bin/sh", "-c", "ls -la /app/server; wc -c < /app/server; echo \"[diagnostic] entrypoint reached at $(date +%s.%N), pid=$$\"; /app/server & pid=$!; wait $pid; echo \"[diagnostic] server (pid $pid) exited with code $? at $(date +%s.%N)\""]
