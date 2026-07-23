# syntax=docker/dockerfile:1
# ORCA synthesized image — recipe rust-cargo (rust).
FROM rust:1-slim AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
RUN cargo fetch
COPY . .
RUN cargo build --release
FROM debian:bookworm-slim
WORKDIR /app
COPY --from=builder /app /app
EXPOSE 8080
CMD ./target/release/orca-rust-sample