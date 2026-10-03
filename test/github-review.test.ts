import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createGitHubReview, githubRepository } from "../src/server/github-review.js";

const exec = promisify(execFile);

async function fixture(remote: string, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jb-github-review-"));
  try {
    await exec("git", ["-C", dir, "init"]);
    await exec("git", ["-C", dir, "remote", "add", "origin", remote]);
    await run(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("GitHub repository resolves SSH and HTTPS origins without treating hostile hosts as GitHub", async () => {
  await fixture("git@github.com:acme/widget.git", async (dir) => assert.deepEqual(await githubRepository(dir), { owner: "acme", repo: "widget" }));
  await fixture("https://github.com/acme/widget.git", async (dir) => assert.deepEqual(await githubRepository(dir), { owner: "acme", repo: "widget" }));
  await fixture("ssh://git@github.com/acme/widget.git", async (dir) => assert.deepEqual(await githubRepository(dir), { owner: "acme", repo: "widget" }));
  await fixture("https://github.com.evil.test/acme/widget", async (dir) => await assert.rejects(githubRepository(dir), /GitHub remote/));
});

test("an unresolved SSH host alias is confirmed through the GitHub API with the token", async () => {
  const requests: Array<{ url: string; auth: string | null }> = [];
  const fakeFetch = (status: number): typeof fetch => async (input, init) => {
    requests.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return Response.json({ full_name: "acme/widget" }, { status });
  };
  await fixture("git@jb-test-unconfigured-alias:acme/widget.git", async (dir) => {
    assert.deepEqual(await githubRepository(dir, "test-token", fakeFetch(200)), { owner: "acme", repo: "widget", host: "jb-test-unconfigured-alias" });
    assert.deepEqual(requests, [{ url: "https://api.github.com/repos/acme/widget", auth: "Bearer test-token" }]);
    await assert.rejects(githubRepository(dir, "test-token", fakeFetch(404)), /not configured on this machine/);
  });
  requests.length = 0;
  await fixture("git@gitlab.example.com:acme/widget.git", async (dir) => await assert.rejects(githubRepository(dir, "test-token", fakeFetch(200)), /GitHub remote origin is required/));
  assert.equal(requests.length, 0);
});

test("an SSH alias owned by a GitHub account is trusted and selects that account's token", async () => {
  await fixture("git@work:acme/widget.git", async (dir) => {
    const requests: Array<{ url: string; auth: string | null }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ workflow_runs: [] });
    };
    const github = await createGitHubReview(dir, { tokenFor: ({ host }) => host === "work" ? "work-token" : "other-token", sshHosts: ["work"] }, fakeFetch);
    assert.deepEqual(github.repository, { owner: "acme", repo: "widget" });
    await github.runs(1);
    assert.deepEqual(requests, [{ url: "https://api.github.com/repos/acme/widget/actions/runs?per_page=30&page=1", auth: "Bearer work-token" }]);
  });
});

test("pull request mutations require token and send only scoped, validated requests", async () => {
  await fixture("git@github.com:acme/widget.git", async (dir) => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? "GET", body: init?.body as string | undefined });
      return Response.json({ id: 42, state: "closed" });
    };
    const withoutToken = await createGitHubReview(dir, undefined, fakeFetch);
    await assert.rejects(withoutToken.review(42, "APPROVE", "Looks good"), /GitHub token/);
    assert.equal(requests.length, 0);
    const github = await createGitHubReview(dir, "test-token", fakeFetch);
    await github.review(42, "REQUEST_CHANGES", "Please fix the failing test");
    assert.equal(requests[0].url, "https://api.github.com/repos/acme/widget/pulls/42/reviews");
    assert.equal(requests[0].method, "POST");
    assert.deepEqual(JSON.parse(requests[0].body!), { event: "REQUEST_CHANGES", body: "Please fix the failing test" });
    await github.close(42);
    assert.equal(requests[1].url, "https://api.github.com/repos/acme/widget/pulls/42");
    assert.deepEqual(JSON.parse(requests[1].body!), { state: "closed" });
    assert.throws(() => github.comment(0, "hello"), /Invalid pull request/);
    assert.equal(requests.length, 2);
  });
});

test("workflow details include actual matrix jobs and declared dependencies", async () => {
  await fixture("https://github.com/acme/widget.git", async (dir) => {
    const workflow = `jobs:\n  changed:\n    runs-on: ubuntu-latest\n  test:\n    needs: changed\n    name: Build and test \${{ matrix.node }}\n    strategy:\n      matrix:\n        node: [20, 22]\n  report:\n    needs: [test]\n`;
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname.endsWith("/jobs")) return Response.json({ total_count: 4, jobs: [
        { id: 1, name: "changed", status: "completed", conclusion: "success", steps: [] },
        { id: 2, name: "Build and test 20", status: "completed", conclusion: "success", steps: [] },
        { id: 3, name: "Build and test 22", status: "completed", conclusion: "success", steps: [] },
        { id: 4, name: "report", status: "completed", conclusion: "success", steps: [] },
      ] });
      if (url.pathname.includes("/contents/")) return Response.json({ content: Buffer.from(workflow).toString("base64") });
      return Response.json({ id: 99, path: ".github/workflows/ci.yml", head_sha: "abc123" });
    };
    const github = await createGitHubReview(dir, "test-token", fakeFetch);
    const detail = await github.run(99);
    assert.deepEqual(detail.dependencies, { changed: [], test: ["changed"], report: ["test"] });
    assert.equal(detail.jobs.length, 4);
    assert.deepEqual(detail.groups.find((group) => group.key === "test")?.jobIds, [2, 3]);
    assert.ok(calls.some((url) => url.endsWith("/contents/.github/workflows/ci.yml")));
  });
});

test("a missing historical workflow shows jobs without inventing dependency edges", async () => {
  await fixture("git@github.com:acme/widget.git", async (dir) => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/jobs")) return Response.json({ total_count: 1, jobs: [{ id: 9, name: "build", status: "completed", conclusion: "success", steps: [] }] });
      if (url.pathname.includes("/contents/")) return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json({ id: 8, path: ".github/workflows/old.yml", head_sha: "abc123" });
    };
    const github = await createGitHubReview(dir, undefined, fakeFetch);
    const detail = await github.run(8);
    assert.match(detail.graphWarning, /dependencies cannot be shown/);
    assert.deepEqual(detail.groups, [{ key: "job-9", name: "build", needs: [], jobIds: [9] }]);
  });
});

test("pull request detail includes later comment pages", async () => {
  await fixture("git@github.com:acme/widget.git", async (dir) => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/issues/42/comments")) return Response.json(url.searchParams.get("page") === "1" ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }]);
      if (url.pathname.endsWith("/pulls/42")) return Response.json({ number: 42 });
      return Response.json([]);
    };
    const github = await createGitHubReview(dir, "test-token", fakeFetch);
    const detail = await github.pull(42);
    assert.equal((detail.comments as Array<{ id: number }>).length, 101);
    assert.deepEqual(detail.truncated, { comments: false, reviews: false, inline: false, files: false });
  });
});

test("job logs follow HTTPS redirects without forwarding the GitHub token", async () => {
  await fixture("git@github.com:acme/widget.git", async (dir) => {
    const calls: Array<{ url: string; authorization: string | undefined }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, authorization: (init?.headers as Record<string, string> | undefined)?.Authorization });
      if (url.endsWith("/logs")) return new Response(null, { status: 302, headers: { Location: "https://results.blob.core.windows.net/job.txt" } });
      return new Response("workflow output");
    };
    const github = await createGitHubReview(dir, "test-token", fakeFetch);
    assert.deepEqual(await github.log(17), { text: "workflow output", truncated: false });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].authorization, "Bearer test-token");
    assert.equal(calls[1].authorization, undefined);
  });
});

test("job logs reject redirects outside GitHub's signed artifact host", async () => {
  await fixture("git@github.com:acme/widget.git", async (dir) => {
    let calls = 0;
    const github = await createGitHubReview(dir, "test-token", async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { Location: "https://attacker.example/job.txt" } });
    });
    await assert.rejects(github.log(17), /redirect host is not trusted/);
    assert.equal(calls, 1);
  });
});

test("GitHub errors do not leak token or retry an uncertain write", async () => {
  await fixture("git@github.com:acme/widget.git", async (dir) => {
    let calls = 0;
    const github = await createGitHubReview(dir, "super-secret", async () => {
      calls += 1;
      return Response.json({ message: "super-secret rejected" }, { status: 403 });
    });
    await assert.rejects(github.comment(8, "Hello"), (error: Error) => !error.message.includes("super-secret") && /GitHub/.test(error.message));
    assert.equal(calls, 1);
  });
});
