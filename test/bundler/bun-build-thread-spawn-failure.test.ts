// Bun.build() (and HTML routes in Bun.serve) run on one lazily started
// "Bundler" thread. Starting it takes two OS resources, and an LD_PRELOAD shim
// fails either one: pthread_create with EAGAIN (what the kernel returns at the
// RLIMIT_NPROC / cgroup pids limit), or the eventfd the thread wakes up on with
// EMFILE (the open-files limit). Both used to abort the whole process ("panic:
// Failed to spawn bun build thread" / "panic: Failed to create waker"); they
// have to fail the build like any other build error, and a later build has to
// try starting the thread again.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isLinux, tempDir } from "harness";
import { join } from "node:path";

const cc = Bun.which("cc") || Bun.which("gcc") || Bun.which("clang");
const skip = !isLinux || !cc;

// Nothing at pthread_create() time says which thread is being created (the name
// is set by the thread itself, and under ASAN every thread even gets the same
// entry point), so the shim narrows it down three ways. The thread has to be
// created by the main thread, the one running Bun.build() / the request handler,
// with Rust's default 2 MiB stack (bun's pools and its HTTP client thread use
// 4 MiB, the allocators pass no attributes), and only while the fixture has the
// BUNDLE_THREAD_SPAWN_ARMED_FILE in place, which it is exactly around the calls
// that start the bundle thread. JSC's on-demand threads also use 2 MiB on ASAN
// builds; the fixtures run a GC right before arming so those are already up.
// Other std-spawned 2 MiB threads (file watchers, the Bun.file() IO thread)
// would be caught too, so the fixtures must not use fs.watch or Bun.file()
// while armed.
//
// eventfd() is easier to attribute: while armed it is only called by the bundle
// thread itself, which names itself "Bundler" before creating its waker.
const BUNDLE_THREAD_STACK_SIZE = 2 * 1024 * 1024;

// A plan has one letter per intercepted attempt: 'f' fails it with the
// resource-limit errno (EAGAIN for pthread_create, EMFILE for eventfd), 'n'
// with ENOMEM, 's' lets it through; the last letter repeats.
// BUNDLE_THREAD_SPAWN_PLAN applies to pthread_create calls for the bundle
// thread, BUNDLE_THREAD_WAKER_PLAN to eventfd() calls made by the bundle
// thread.
const SHIM_C = /* c */ `
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

static int (*real_pthread_create)(pthread_t *, const pthread_attr_t *, void *(*)(void *), void *);
static int (*real_eventfd)(unsigned int, int);
static const char *armed_file;
static const char *spawn_plan, *waker_plan;
static size_t spawn_attempts, waker_attempts;

__attribute__((constructor)) static void init(void) {
  real_pthread_create = dlsym(RTLD_NEXT, "pthread_create");
  real_eventfd = dlsym(RTLD_NEXT, "eventfd");
  armed_file = getenv("BUNDLE_THREAD_SPAWN_ARMED_FILE");
  spawn_plan = getenv("BUNDLE_THREAD_SPAWN_PLAN");
  waker_plan = getenv("BUNDLE_THREAD_WAKER_PLAN");
}

// 0 when the plan is unset, the fixture has not armed the shim, or the step
// is 's' (let it through).
static char plan_step(const char *plan, size_t *attempts) {
  size_t len = plan ? strlen(plan) : 0;
  if (len == 0 || !armed_file || access(armed_file, F_OK) != 0) return 0;
  size_t i = __sync_fetch_and_add(attempts, 1);
  char step = plan[i < len ? i : len - 1];
  return step == 's' ? 0 : step;
}

int pthread_create(pthread_t *thread, const pthread_attr_t *attr, void *(*start)(void *), void *arg) {
  size_t stack_size = 0;
  if (attr) pthread_attr_getstacksize(attr, &stack_size);
  if (stack_size == ${BUNDLE_THREAD_STACK_SIZE} && syscall(SYS_gettid) == getpid()) {
    switch (plan_step(spawn_plan, &spawn_attempts)) {
      case 'f': return EAGAIN;
      case 'n': return ENOMEM;
    }
  }
  return real_pthread_create(thread, attr, start, arg);
}

int eventfd(unsigned int initval, int flags) {
  char name[16] = {0};
  if (prctl(PR_GET_NAME, name) == 0 && strcmp(name, "Bundler") == 0) {
    switch (plan_step(waker_plan, &waker_attempts)) {
      case 'f': errno = EMFILE; return -1;
      case 'n': errno = ENOMEM; return -1;
    }
  }
  return real_eventfd(initval, flags);
}
`;

const MODES = [
  {
    name: "pthread_create fails",
    planEnv: "BUNDLE_THREAD_SPAWN_PLAN",
    error:
      "Failed to start the bundler thread: EAGAIN. The process or thread limit may have been reached (ulimit -u, or the container's pids limit).",
  },
  {
    name: "creating its waker fails",
    planEnv: "BUNDLE_THREAD_WAKER_PLAN",
    error:
      "Failed to start the bundler thread: EMFILE. The open file limit may have been reached (ulimit -n, or the system-wide limit).",
  },
];

// The sync fs calls arm and disarm the shim without creating threads themselves.
const ARM_HELPERS = /* js */ `
import { unlinkSync, writeFileSync } from "node:fs";
function arm() {
  Bun.gc(true);
  writeFileSync(process.env.BUNDLE_THREAD_SPAWN_ARMED_FILE, "");
}
function disarm() {
  unlinkSync(process.env.BUNDLE_THREAD_SPAWN_ARMED_FILE);
}
`;

// Prints one JSON line per Bun.build() call; `throw` is taken from argv so the
// same fixture covers the rejecting and the { success: false } flavors.
// Bun.build() starts the bundle thread (including its waker) before it returns
// its promise.
const BUILD_FIXTURE = /* js */ `
${ARM_HELPERS}
const [, , throwArg, count] = process.argv;
for (let i = 0; i < Number(count); i++) {
  let onEnd = "not called";
  const plugin = { name: "record", setup(build) { build.onEnd(result => { onEnd = result.success; }); } };
  arm();
  let build;
  try {
    build = Bun.build({
      entrypoints: [import.meta.dirname + "/entry.js"],
      throw: throwArg === "throw",
      plugins: [plugin],
    });
  } finally {
    disarm();
  }
  try {
    const result = await build;
    console.log(JSON.stringify({ settled: "resolved", success: result.success, logs: result.logs.map(l => l.message), onEnd }));
  } catch (e) {
    console.log(JSON.stringify({ settled: "rejected", name: e.name, message: e.message, errors: e.errors.map(err => err.message), onEnd }));
  }
}
`;

// Without HMR an HTML route is bundled by the same bundle thread when it is
// requested. development: { hmr: false } (rather than false) rebundles on every
// request and writes a failed build's log to stderr, so the second request
// shows whether the thread gets started again.
const SERVE_FIXTURE = /* js */ `
${ARM_HELPERS}
import index from "./index.html";
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", development: { hmr: false }, routes: { "/": index } });
arm();
let first, second;
try {
  first = await fetch(server.url);
  second = await fetch(server.url);
} finally {
  disarm();
}
console.log(JSON.stringify({ first: first.status, second: second.status }));
server.stop(true);
`;

let dir: ReturnType<typeof tempDir> | undefined;
let shimPath: string;

beforeAll(async () => {
  if (skip) return;
  dir = tempDir("bundle-thread-spawn-failure", {
    "shim.c": SHIM_C,
    "entry.js": `import { a } from "./a.js";\nconsole.log(a);\n`,
    "a.js": `export const a = 1;\n`,
    "build.js": BUILD_FIXTURE,
    "serve.js": SERVE_FIXTURE,
    "index.html": `<!doctype html><script type="module" src="./entry.js"></script>`,
  });
  shimPath = join(String(dir), "shim.so");
  await using ccProc = Bun.spawn({
    cmd: [cc!, "-shared", "-fPIC", "-o", shimPath, join(String(dir), "shim.c"), "-ldl"],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [ccOut, ccErr, ccExit] = await Promise.all([ccProc.stdout.text(), ccProc.stderr.text(), ccProc.exited]);
  if (ccExit !== 0) {
    throw new Error(`shim compile failed: ${ccErr || ccOut}`);
  }
});

afterAll(() => {
  dir?.[Symbol.dispose]();
});

let runs = 0;

async function runWithPlan(planEnv: string, plan: string, ...args: string[]) {
  const existing = bunEnv.LD_PRELOAD;
  await using proc = Bun.spawn({
    cmd: [bunExe(), ...args],
    cwd: String(dir),
    env: {
      ...bunEnv,
      LD_PRELOAD: existing ? `${shimPath}:${existing}` : shimPath,
      [planEnv]: plan,
      // Per run: a fixture that crashes while armed must not arm the others.
      BUNDLE_THREAD_SPAWN_ARMED_FILE: join(String(dir), `armed-${runs++}`),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return {
    results: stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line)),
    stderr: stderr.trim(),
    exitCode,
    signalCode: proc.signalCode,
  };
}

describe.skipIf(skip)("Bun.build() when the bundle thread cannot be started because", () => {
  describe.each(MODES)("$name", ({ planEnv, error }) => {
    test.concurrent("rejects with the error in the AggregateError", async () => {
      expect(await runWithPlan(planEnv, "f", "build.js", "throw", "1")).toEqual({
        results: [
          {
            settled: "rejected",
            name: "AggregateError",
            message: "Bundle failed",
            errors: [error],
            onEnd: false,
          },
        ],
        stderr: "",
        exitCode: 0,
        signalCode: null,
      });
    });

    test.concurrent("resolves with success: false and the error in the logs under throw: false", async () => {
      expect(await runWithPlan(planEnv, "f", "build.js", "nothrow", "1")).toEqual({
        results: [{ settled: "resolved", success: false, logs: [error], onEnd: false }],
        stderr: "",
        exitCode: 0,
        signalCode: null,
      });
    });

    test.concurrent("reports other errors without the resource-limit hint", async () => {
      expect(await runWithPlan(planEnv, "n", "build.js", "nothrow", "1")).toEqual({
        results: [
          { settled: "resolved", success: false, logs: ["Failed to start the bundler thread: ENOMEM."], onEnd: false },
        ],
        stderr: "",
        exitCode: 0,
        signalCode: null,
      });
    });

    test.concurrent("the next build starts the thread again", async () => {
      expect(await runWithPlan(planEnv, "fs", "build.js", "nothrow", "2")).toEqual({
        results: [
          { settled: "resolved", success: false, logs: [error], onEnd: false },
          { settled: "resolved", success: true, logs: [], onEnd: true },
        ],
        stderr: "",
        exitCode: 0,
        signalCode: null,
      });
    });

    test.concurrent("every build fails while the thread keeps failing to start", async () => {
      expect(await runWithPlan(planEnv, "f", "build.js", "nothrow", "2")).toEqual({
        results: [
          { settled: "resolved", success: false, logs: [error], onEnd: false },
          { settled: "resolved", success: false, logs: [error], onEnd: false },
        ],
        stderr: "",
        exitCode: 0,
        signalCode: null,
      });
    });

    test.concurrent("an HTML route in Bun.serve answers 500, then builds once the thread starts", async () => {
      const { stderr, ...rest } = await runWithPlan(planEnv, "fs", "serve.js");
      expect({ ...rest, stderrLines: stderr.split("\n") }).toEqual({
        results: [{ first: 500, second: 200 }],
        // The failed first build's log, then the second request's bundle timing.
        stderrLines: [`error: ${error}`, expect.stringMatching(/^\[[\d.]+m?s\] bundle index\.html /)],
        exitCode: 0,
        signalCode: null,
      });
    });
  });
});
