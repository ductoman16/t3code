// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell script against scratch Git repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

const SCRIPT = NodePath.resolve(import.meta.dirname, "voice-fork-catch-up.sh");
const BRANCH = "voice-mode";
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true })));
});

function git(cwd: string, ...args: string[]): string {
  return NodeChildProcess.execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
}

/** A fork with two commits, this checkout of it, and a second checkout that merges into the fork. */
async function setup() {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-fork-catch-up-")),
  );
  roots.push(root);
  const seed = NodePath.join(root, "seed");
  await NodeFSP.mkdir(seed);
  git(seed, "init", "--quiet", "--initial-branch", BRANCH);
  git(seed, "commit", "--quiet", "--allow-empty", "--message", "release");
  git(seed, "commit", "--quiet", "--allow-empty", "--message", "voice mode");
  git(root, "clone", "--quiet", "--bare", seed, "fork.git");
  const fork = NodePath.join(root, "fork.git");
  git(root, "clone", "--quiet", fork, "here");
  git(root, "clone", "--quiet", fork, "elsewhere");
  const here = NodePath.join(root, "here");
  const elsewhere = NodePath.join(root, "elsewhere");
  return {
    here,
    /** A PR merging into the fork from another checkout. */
    mergeIntoFork(message: string) {
      git(elsewhere, "pull", "--quiet", "--ff-only");
      git(elsewhere, "commit", "--quiet", "--allow-empty", "--message", message);
      git(elsewhere, "push", "--quiet", "origin", BRANCH);
      return git(elsewhere, "rev-parse", "HEAD");
    },
    catchUp() {
      const run = NodeChildProcess.spawnSync("bash", [SCRIPT, BRANCH], {
        cwd: here,
        env: ENV,
        encoding: "utf8",
      });
      return { status: run.status, stdout: run.stdout.trim(), stderr: run.stderr };
    },
    head: () => git(here, "rev-parse", "HEAD"),
  };
}

describe("voice-fork-catch-up.sh", () => {
  it("keeps a branch that already holds the fork's tip", async () => {
    const env = await setup();
    const fork = env.head();
    git(env.here, "commit", "--quiet", "--allow-empty", "--message", "local work");
    const local = env.head();

    expect(env.catchUp()).toMatchObject({ status: 0, stdout: fork });
    expect(env.head()).toBe(local);
  });

  it("fast-forwards a branch that is only behind the fork", async () => {
    const env = await setup();
    const merged = env.mergeIntoFork("merged PR");

    expect(env.catchUp()).toMatchObject({ status: 0, stdout: merged });
    expect(env.head()).toBe(merged);
  });

  it("keeps an unpushed rebase off the fork's tip onto a new release", async () => {
    const env = await setup();
    const fork = env.head();
    git(env.here, "checkout", "--quiet", "-b", "release", `${BRANCH}~1`);
    git(env.here, "commit", "--quiet", "--allow-empty", "--message", "new release");
    git(env.here, "rebase", "--quiet", "--onto", "release", `${BRANCH}~1`, BRANCH);
    const rebased = env.head();

    expect(env.catchUp()).toMatchObject({ status: 0, stdout: fork });
    expect(env.head()).toBe(rebased);
  });

  it("refuses an unpushed rebase once the fork has moved on", async () => {
    const env = await setup();
    git(env.here, "checkout", "--quiet", "-b", "release", `${BRANCH}~1`);
    git(env.here, "commit", "--quiet", "--allow-empty", "--message", "new release");
    git(env.here, "rebase", "--quiet", "--onto", "release", `${BRANCH}~1`, BRANCH);
    const merged = env.mergeIntoFork("merged PR");

    const run = env.catchUp();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`reset it to ${merged.slice(0, 10)}`);
  });

  it("refuses a branch reset behind the fork's tip and committed to", async () => {
    const env = await setup();
    git(env.here, "reset", "--quiet", "--hard", "HEAD~1");
    git(env.here, "commit", "--quiet", "--allow-empty", "--message", "work on an old commit");

    expect(env.catchUp().status).toBe(1);
  });
});
