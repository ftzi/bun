// scripts/rust-test.ts links and runs the Miri crate set (scripts/rust-miri.ts)
// as ordinary host test binaries; .github/workflows/miri.yml runs it in CI.
// Miri itself never links, so it cannot tell when one of those crates' tests
// starts reaching a symbol that only the full bun binary defines. bun_ptr is
// the example this exists for: `type_base_name` (src/ptr/ref_count.rs) goes
// through bun_core::strings, i.e. the highway C++ kernels, and `RefCount`'s
// ThreadLock pulls in bun_core's OutputSink interface, whose only arm is in
// bun_sys. src/ptr/native_test_shims.rs defines both for the test binary;
// without it the run fails with
//   ld.lld: error: undefined symbol: highway_memrmem
//   ld.lld: error: undefined symbol: __bun_dispatch__OutputSink__Sys__stderr
// (and a COFF link forced through instead crashes in
// type_base_name_strips_module_path, which is why the tests are run, not just
// linked).
//
// Same prerequisites as rust-windows-sys-link.test.ts: cargo on PATH and a
// configured checkout (cargo needs vendor/lolhtml to resolve the workspace,
// bun_core/build.rs needs build_options.rs). The test-only CI lanes have
// neither and skip.
import { which } from "bun";
import { expect, test } from "bun:test";
import { bunEnv, bunExe } from "harness";
import { existsSync } from "node:fs";
import { join } from "node:path";

const cargo = which("cargo");
const repoRoot = join(import.meta.dir, "..", "..");
const workspaceResolvable =
  existsSync(join(repoRoot, "vendor", "lolhtml", "Cargo.toml")) &&
  existsSync(join(repoRoot, "build", "debug", "codegen", "build_options.rs"));

test.skipIf(!cargo || !workspaceResolvable)(
  "the Miri crate set links and passes as plain cargo test binaries",
  async () => {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "scripts/rust-test.ts"],
      cwd: repoRoot,
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    expect(stderr).not.toContain("undefined symbol");
    // The bun_ptr test that reaches the shimmed kernels must have actually run.
    expect(stdout).toContain("test ref_count::tests::type_base_name_strips_module_path ... ok");
    expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 });
  },
  // Cold target dir: builds bun_core and the rest of the crates' closures first.
  600_000,
);
