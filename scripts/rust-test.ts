#!/usr/bin/env bun
/**
 * Plain `cargo test` for the Miri crate set (MIRI_CRATES in rust-miri.ts).
 *
 * A crate's test binary links the crate's Rust dependencies and nothing else.
 * Everything the full bun binary gets from C/C++ (the highway kernels behind
 * `bun_core::strings`, mimalloc, ...) or from a higher-tier crate (the
 * `bun_sys` arm of `bun_core`'s `OutputSink`) is missing, so a test that
 * reaches one either gets it from the crate's own `#[cfg(test)]` shim module
 * (src/ptr/native_test_shims.rs, src/parsers/native_test_shims.rs) or fails to
 * link, naming the symbol. Miri never links, and `bun_highway` takes scalar
 * paths under `cfg(miri)`, so `rust:miri` stays green either way; this is the
 * lane that notices.
 *
 * Usage:
 *   bun run rust:test              # MIRI_CRATES minus NATIVE_LINK_PENDING, then the pending check
 *   bun run rust:test -p bun_foo   # extra args go straight to cargo test
 */

import { MIRI_CRATES, ensureConfigured, run } from "./rust-miri.ts";

// Miri crates whose test binaries do not link natively yet, with the live
// reference that stops them. Each entry is re-linked below and fails this
// script once the crate links, so the list can only shrink.
const NATIVE_LINK_PENDING = [
  // `TapeAlloc::Arena` keeps `MimallocArena` live: mi_heap_malloc, mi_free_size, ...
  "bun_ast",
  // `StreamingClap::normal` reaches highway_index_of_char.
  "bun_clap",
];

ensureConfigured();

const extraArgs = process.argv.slice(2);
const crateArgs =
  extraArgs.length > 0
    ? extraArgs
    : MIRI_CRATES.filter(crate => !NATIVE_LINK_PENDING.includes(crate)).flatMap(crate => ["-p", crate]);

console.log(`\x1b[36m[test]\x1b[0m cargo test --locked ${crateArgs.join(" ")}`);
if (run("cargo", ["test", "--locked", ...crateArgs]).status !== 0) process.exit(1);
if (extraArgs.length > 0) process.exit(0);

for (const crate of NATIVE_LINK_PENDING) {
  if (!MIRI_CRATES.includes(crate)) {
    console.error(`\x1b[31m[error]\x1b[0m ${crate} is in NATIVE_LINK_PENDING but not in MIRI_CRATES`);
    process.exit(1);
  }
  console.log(`\x1b[36m[test]\x1b[0m cargo test --locked --no-run -p ${crate} (pending: expected not to link)`);
  if (run("cargo", ["test", "--locked", "--no-run", "-p", crate], { stdio: "pipe" }).status === 0) {
    console.error(
      `\x1b[31m[error]\x1b[0m ${crate} links natively now; remove it from NATIVE_LINK_PENDING in scripts/rust-test.ts`,
    );
    process.exit(1);
  }
}
