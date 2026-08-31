//! The ShaderToolService — the product host boundary of the toolchain
//! client (design authority: `docs/GGLab_Shader_Toolchain_Integration_Design.md`,
//! sections 8, 9, and 10).
//!
//! One crate module, deliberately small, because the boundary is
//! deliberately small: exactly six tool capabilities (`discover` / `handshake` /
//! `preview_handshake` / `compile` / `build_preview` / `cancel`), one separate
//! compiler-free Preview observation read, and the
//! host-internal jobs behind them — allowance (the request is an
//! allowlisted shape), serialization (the approved request becomes the
//! tool's invocation — structural arguments, no shell string, no
//! policy), execution (the provenance guard FIRST, then bounded
//! execution), and the private per-attempt staging.
//!
//! What this module is NOT: no protocol interpretation (no envelope
//! parsing, no status vocabulary, no version comparison, no diagnostic
//! classification — the raw output surface is its ENTIRE output), no
//! readiness logic (it cannot be asked whether a request is a good one),
//! no argv in any TypeScript-facing surface, no graph or profile
//! knowledge. The client package declares the contract and interprets
//! the bytes; its reference fake is the test-side implementation of the
//! same contract. The two implementations never import each other.
//!
//! # Modules
//!
//! - `types` — the wire shapes, one-to-one with the client's declared
//!   boundary (`types.rs`);
//! - `identity` — the host's observation-identity token (a SHA-256
//!   content hash — opaque to the client);
//! - `discovery` — the rule walk (bookkeeping only);
//! - `provenance` — the pre-spawn guard (a share-mode that blocks
//!   write/delete/replace/replace, held until the spawn settles);
//! - `execution` — the budget + cancel + whole-capture mechanics;
//! - `staging` — the private root layout (per-attempt isolation);
//! - `service` — the six tool capabilities and observation read, tied together.

pub mod discovery;
pub mod error;
pub mod execution;
pub mod identity;
pub mod provenance;
pub mod service;
pub mod staging;
pub mod types;
