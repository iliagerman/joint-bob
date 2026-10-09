import { execFile } from "../subprocess.js";
import { promisify } from "node:util";
import { parse } from "yaml";
import { GitReviewError } from "../git-review.js";
const exec = promisify(execFile);
const API = "https://api.github.com";
const MAX_LOG_BYTES = 1024 * 1024;
const BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}(?<!\/)$/;
function tokenFor(credentials, repository) {
  return typeof credentials === "object" ? credentials.tokenFor(repository) : credentials;
}
async function githubRepository(cwd, credentials, request = fetch) {
  let remote;
  try {
    remote = (await exec("git", ["-C", cwd, "remote", "get-url", "origin"], { timeout: 1e4 })).stdout.trim();
  } catch {
    throw new GitReviewError(400, "GitHub remote origin is not configured");
  }
  const scp = remote.match(/^git@([A-Za-z0-9][A-Za-z0-9_.-]*):([^/]+)\/([^/]+?)(?:\.git)?$/);
  let parts = scp?.slice(2);
  if (!parts) {
    let url;
    try {
      url = new URL(remote);
    } catch {
      throw new GitReviewError(400, "GitHub remote origin is invalid");
    }
    const https = url.protocol === "https:" && !url.username;
    const sshUrl = url.protocol === "ssh:" && url.username === "git";
    if (!https && !sshUrl || url.hostname !== "github.com" || url.password) throw new GitReviewError(400, "GitHub remote origin is required");
    parts = url.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
  }
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..")) throw new GitReviewError(400, "GitHub remote origin is invalid");
  const [owner, repo] = parts;
  if (!scp || scp[1] === "github.com") return { owner, repo };
  const host = scp[1];
  const known = typeof credentials === "object" && credentials.sshHosts?.some((item) => item.toLowerCase() === host.toLowerCase());
  if (!known) await assertSshAliasIsGithub(host, `/repos/${owner}/${repo}`, tokenFor(credentials, { owner, host }), request);
  return { owner, repo, host };
}
async function assertSshAliasIsGithub(host, repoRoute, token, request) {
  let resolved = host;
  try {
    const config = (await exec("ssh", ["-G", "--", host], { timeout: 1e4 })).stdout;
    resolved = config.match(/^hostname (\S+)$/m)?.[1]?.toLowerCase() ?? host;
  } catch {
  }
  if (resolved === "github.com") return;
  if (resolved !== host.toLowerCase() || host.includes(".")) throw new GitReviewError(400, "GitHub remote origin is required");
  try {
    await githubRequest(repoRoute, token, request, "");
  } catch (error) {
    if (error instanceof GitReviewError && error.status === 502) throw error;
    throw new GitReviewError(400, `GitHub remote host "${host}" is not configured on this machine and the repository was not found with the GitHub token`);
  }
}
function assertId(id, label) {
  if (!Number.isSafeInteger(id) || id < 1) throw new GitReviewError(400, `Invalid ${label}`);
}
function assertBody(body) {
  if (!body.trim() || body.length > 65536) throw new GitReviewError(400, "Comment must contain 1 to 65536 characters");
}
async function githubRequest(base, token, request, route, method = "GET", body) {
  if (method !== "GET" && !token) throw new GitReviewError(403, "Attach a GitHub token to perform this action");
  let response;
  try {
    response = await request(`${API}${base}${route}`, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(3e4),
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...token ? { Authorization: `Bearer ${token}` } : {}, ...body ? { "Content-Type": "application/json" } : {} },
      ...body ? { body: JSON.stringify(body) } : {}
    });
  } catch {
    throw new GitReviewError(502, "Could not reach GitHub");
  }
  if (!response.ok) throw new GitReviewError(response.status === 404 ? 404 : response.status === 401 || response.status === 403 ? 403 : 502, `GitHub request failed (HTTP ${response.status})`);
  try {
    return await response.json();
  } catch {
    throw new GitReviewError(502, "GitHub returned invalid JSON");
  }
}
async function collection(call, route) {
  const items = [];
  for (let page = 1; page <= 5; page += 1) {
    const batch = await call(`${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return { items, truncated: false };
  }
  return { items, truncated: true };
}
async function pullDetail(call, number) {
  assertId(number, "pull request");
  const route = `/pulls/${number}`;
  const [pull, comments, reviews, inline, files] = await Promise.all([
    call(route),
    collection(call, `/issues/${number}/comments`),
    collection(call, `${route}/reviews`),
    collection(call, `${route}/comments`),
    collection(call, `${route}/files`)
  ]);
  return { pull, comments: comments.items, reviews: reviews.items, inline: inline.items, files: files.items, truncated: { comments: comments.truncated, reviews: reviews.truncated, inline: inline.truncated, files: files.truncated } };
}
async function runDetails(call, id) {
  assertId(id, "workflow run");
  const detail = await call(`/actions/runs/${id}`);
  const jobs = [];
  let total = 0;
  for (let page = 1; page <= 5; page += 1) {
    const batch = await call(`/actions/runs/${id}/jobs?per_page=100&page=${page}`);
    total = batch.total_count;
    jobs.push(...batch.jobs);
    if (jobs.length >= total) break;
  }
  if (!/^\.github\/workflows\/[\w./-]+\.ya?ml$/.test(detail.path) || detail.path.includes("..")) throw new GitReviewError(502, "GitHub workflow path is invalid");
  let workflow;
  try {
    const source = await call(`/contents/${detail.path}?ref=${encodeURIComponent(detail.head_sha)}`);
    if (typeof source.content !== "string") throw new GitReviewError(502, "GitHub workflow content is missing");
    try {
      workflow = parse(Buffer.from(source.content, "base64").toString("utf8"));
    } catch {
      throw new GitReviewError(502, "Could not parse GitHub workflow");
    }
  } catch (error) {
    if (!(error instanceof GitReviewError) || error.status !== 404) throw error;
    return { run: detail, jobs, dependencies: {}, groups: jobs.map((job) => ({ key: `job-${job.id}`, name: job.name, needs: [], jobIds: [job.id] })), graphWarning: "Workflow file unavailable at this commit; dependencies cannot be shown", truncated: jobs.length < total };
  }
  if (!workflow?.jobs || typeof workflow.jobs !== "object") throw new GitReviewError(502, "GitHub workflow has no jobs");
  return workflowGroups(detail, jobs, workflow.jobs, total);
}
function workflowGroups(detail, jobs, definitions, total) {
  const dependencies = {};
  const groups = Object.entries(definitions).map(([key, job]) => {
    const needs = job.needs ? [job.needs].flat() : [];
    dependencies[key] = needs;
    const prefix = (job.name ?? key).split("${{")[0].trim();
    return { key, name: job.name ?? key, needs, jobIds: jobs.filter((item) => item.name === key || item.name.startsWith(`${key} (`) || prefix && item.name.startsWith(prefix)).map((item) => item.id) };
  });
  const matched = new Set(groups.flatMap((group) => group.jobIds));
  const unmatched = jobs.filter((job) => !matched.has(job.id));
  groups.push(...unmatched.map((job) => ({ key: `job-${job.id}`, name: job.name, needs: [], jobIds: [job.id] })));
  return { run: detail, jobs, dependencies, groups, ...unmatched.length ? { graphWarning: `${unmatched.length} jobs could not be matched to workflow definitions; their dependencies are not shown` } : {}, truncated: jobs.length < total };
}
async function downloadJobLog(url, token, request) {
  let first;
  try {
    first = await request(url, { redirect: "manual", signal: AbortSignal.timeout(3e4), headers: { Accept: "application/vnd.github+json", ...token ? { Authorization: `Bearer ${token}` } : {} } });
  } catch {
    throw new GitReviewError(502, "Could not reach GitHub logs");
  }
  if (first.status !== 302 && !first.ok) throw new GitReviewError(502, `GitHub log request failed (HTTP ${first.status})`);
  const location = first.status === 302 ? first.headers.get("location") : null;
  if (first.status === 302) {
    let target;
    try {
      target = new URL(location);
    } catch {
      throw new GitReviewError(502, "GitHub log redirect is invalid");
    }
    if (target.protocol !== "https:" || !target.hostname.endsWith(".blob.core.windows.net")) throw new GitReviewError(502, "GitHub log redirect host is not trusted");
  }
  let download;
  try {
    download = location ? await request(location, { signal: AbortSignal.timeout(3e4) }) : first;
  } catch {
    throw new GitReviewError(502, "Could not download GitHub logs");
  }
  if (!download.ok || !download.body) throw new GitReviewError(502, `GitHub log download failed (HTTP ${download.status})`);
  const reader = download.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (bytes <= MAX_LOG_BYTES) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value.subarray(0, Math.max(0, MAX_LOG_BYTES - bytes)));
    bytes += value.byteLength;
  }
  if (bytes > MAX_LOG_BYTES) await reader.cancel();
  return { text: Buffer.concat(chunks).subarray(0, MAX_LOG_BYTES).toString("utf8"), truncated: bytes > MAX_LOG_BYTES };
}
async function createGitHubReview(cwd, credentials, request = fetch) {
  const { owner, repo, host } = await githubRepository(cwd, credentials, request);
  const token = tokenFor(credentials, { owner, host });
  const base = `/repos/${owner}/${repo}`;
  const call = (route, method, body) => githubRequest(base, token, request, route, method, body);
  const log = (id) => {
    assertId(id, "job");
    return downloadJobLog(`${API}${base}/actions/jobs/${id}/logs`, token, request);
  };
  return {
    repository: { owner, repo },
    pulls: (state, page) => call(`/pulls?state=${state}&per_page=30&page=${page}&sort=updated&direction=desc`),
    create: (head, target, title, body, draft) => {
      if (!BRANCH.test(head) || !BRANCH.test(target) || head === target) throw new GitReviewError(400, "Choose different, valid head and base branches");
      if (!title.trim() || title.length > 256 || body.length > 65536) throw new GitReviewError(400, "Invalid pull request title or description");
      return call("/pulls", "POST", { head, base: target, title: title.trim(), body, draft });
    },
    pull: (number) => pullDetail(call, number),
    comment: (number, body) => {
      assertId(number, "pull request");
      assertBody(body);
      return call(`/issues/${number}/comments`, "POST", { body });
    },
    review: (number, event, body) => {
      assertId(number, "pull request");
      if (event !== "APPROVE" && event !== "REQUEST_CHANGES") throw new GitReviewError(400, "Invalid review decision");
      if (event === "REQUEST_CHANGES") assertBody(body);
      return call(`/pulls/${number}/reviews`, "POST", { event, body });
    },
    close: (number) => {
      assertId(number, "pull request");
      return call(`/pulls/${number}`, "PATCH", { state: "closed" });
    },
    reopen: (number) => {
      assertId(number, "pull request");
      return call(`/pulls/${number}`, "PATCH", { state: "open" });
    },
    merge: (number, sha, method) => {
      assertId(number, "pull request");
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitReviewError(400, "Invalid pull request head");
      return call(`/pulls/${number}/merge`, "PUT", { sha, merge_method: method });
    },
    storyPull: async (number) => {
      assertId(number, "pull request");
      const pull = await call(`/pulls/${number}`);
      if (pull.changed_files > 500) throw new GitReviewError(413, "This PR changes more than 500 files; it is too large for one story");
      const files = await collection(call, `/pulls/${number}/files`);
      if (files.truncated || files.items.length !== pull.changed_files) throw new GitReviewError(413, "Could not read every PR file for the story");
      return { pull, files: files.items };
    },
    runs: (page) => call(`/actions/runs?per_page=30&page=${page}`),
    run: (id) => runDetails(call, id),
    log
  };
}
export {
  createGitHubReview,
  githubRepository,
  githubRequest
};
