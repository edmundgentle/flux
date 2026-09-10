# ==========================================
# 1. Builder Stage
# ==========================================
# Trixie (not bookworm) is required: ort's prebuilt static onnxruntime library needs a
# newer libstdc++ ABI than bookworm's GCC 12 ships (otherwise linking fails with
# "undefined reference to `__cxa_call_terminate'" / `_M_replace_cold` errors).
FROM rust:1.88-slim-trixie AS builder

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

# Force fresh mtimes so Cargo doesn't reuse the dummy binary (COPY can normalize
# timestamps to a fixed value that appears older than the cached dummy build)
RUN find src -exec touch {} + && touch -c src/main.rs

# Remove the dummy binary/fingerprints so this build is forced to relink
RUN rm -f target/release/flux-homeassistant target/release/deps/flux_homeassistant-*

# Build the release binary (ort statically links its own onnxruntime binary at this step)
RUN cargo build --release

# The ONNX models used for offline object/face detection and facial fingerprinting are committed
# to the repo (see models/download-models.sh / models/export_facenet_onnx.py to regenerate them) —
# they're just copied in here rather than fetched/exported at build time, since builds may run
# without reliable network/Python access (e.g. cross-arch HA add-on builds under QEMU).
COPY models ./models

# ==========================================
# 2. Runner Stage
# ==========================================
# Must match the builder's Debian release so the runtime libstdc++/glibc are new enough
# for the binary produced above.
FROM debian:trixie-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy binary from builder
COPY --from=builder /usr/src/app/target/release/flux-homeassistant /app/server

# Copy vision models from builder
COPY --from=builder /usr/src/app/models /app/models
ENV MODELS_DIR=/app/models


# Expose port
EXPOSE 8080

# Environment variables
ENV RUST_LOG=info

# Start the application
CMD ["/app/server"]
