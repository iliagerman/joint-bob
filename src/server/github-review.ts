import { execFile } from "../subprocess.js";
import { promisify } from "node:util";
import { parse } from "yaml";
import { GitReviewError } from "../git-review.js";

const exec = promisify(execFile);
const API = "https://api.github.com";
const MAX_LOG_BYTES = 1024 * 1024;
type GithubCall = (route: string, method?: string, body?: object) => Promise<unknown>;
/** Picks a token per repository, so two GitHub accounts can serve different remotes. */
export interface GithubCredentials { tokenFor(repository: { owner: string; host?: string }): string | undefined; sshHosts?: string[] }
type Credentials = string | undefined | GithubCredentials;

function tokenFor(credentials: Credentials, repository: { owner: string; host?: string }): string | undefined {
  return typeof credentials === "object" ? credentials.tokenFor(repository) : credentials;
}

export async function githubRepository(cwd: string, credentials?: Credentials, request: typeof fetch = fetch): Promise<{ owner: string; repo: string; host?: string }> {
  let remote: string;
  try { remote = (await exec("git", ["-C", cwd, "remote", "get-url", "origin"], { timeout: 10_000 })).stdout.trim(); }
  catch { throw new GitReviewError(400, "GitHub remote origin is not configured"); }
  const scp = remote.match(/^git@([A-Za-z0-9][A-Za-z0-9_.-]*):([^/]+)\/([^/]+?)(?:\.git)?$/);
  let parts = scp?.slice(2);
  if (!parts) {
    let url: URL;
    try { url = new URL(remote); } catch { throw new GitReviewError(400, "GitHub remote origin is invalid"); }
    const https = url.protocol === "https:" && !url.username;
    const sshUrl = url.protocol === "ssh:" && url.username === "git";
    if ((!https && !sshUrl) || url.hostname !== "github.com" || url.password) throw new GitReviewError(400, "GitHub remote origin is required");
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

// SSH host aliases (git@work:owner/repo) resolve via ~/.ssh/config, which may be absent on this node.
async function assertSshAliasIsGithub(host: string, repoRoute: string, token: string | undefined, request: typeof fetch): Promise<void> {
  let resolved = host;
  try {
    const config = (await exec("ssh", ["-G", "--", host], { timeout: 10_000 })).stdout;
    resolved = config.match(/^hostname (\S+)$/m)?.[1]?.toLowerCase() ?? host;
  } catch { /* ssh unavailable: confirm through the API */ }
  if (resolved === "github.com") return;
  if (resolved !== host.toLowerCase() || host.includes(".")) throw new GitReviewError(400, "GitHub remote origin is required");
  try { await githubRequest(repoRoute, token, request, ""); }
  catch (error) {
    if (error instanceof GitReviewError && error.status === 502) throw error;
    throw new GitReviewError(400, `GitHub remote host "${host}" is not configured on this machine and the repository was not found with the GitHub token`);
  }
}

function assertId(id: number, label: string): void {
  if (!Number.isSafeInteger(id) || id < 1) throw new GitReviewError(400, `Invalid ${label}`);
}

function assertBody(body: string): void {
  if (!body.trim() || body.length > 65536) throw new GitReviewError(400, "Comment must contain 1 to 65536 characters");
}

interface GithubJob { id: number; name: string; status: string; conclusion: string | null; steps: Array<{ name: string; status: string; conclusion: string | null }> }
interface WorkflowRun { id: number; path: string; head_sha: string; [key: string]: unknown }
interface WorkflowJob { name?: string; needs?: string | string[] }

export async function githubRequest(base: string, token: string | undefined, request: typeof fetch, route: string, method = "GET", body?: object): Promise<unknown> {
  if (method !== "GET" && !token) throw new GitReviewError(403, "Attach a GitHub token to perform this action");
  let response: Response;
  try {
    response = await request(`${API}${base}${route}`, {
      method, redirect: "manual", signal: AbortSignal.timeout(30_000),
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new GitReviewError(502, "Could not reach GitHub"); }
  if (!response.ok) throw new GitReviewError(response.status === 404 ? 404 : response.status === 401 || response.status === 403 ? 403 : 502, `GitHub request failed (HTTP ${response.status})`);
  try { return await response.json(); } catch { throw new GitReviewError(502, "GitHub returned invalid JSON"); }
}

async function collection(call: GithubCall, route: string): Promise<{ items: unknown[]; truncated: boolean }> {
  const items: unknown[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const batch = await call(`${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`) as unknown[];
    items.push(...batch);
    if (batch.length < 100) return { items, truncated: false };
  }
  return { items, truncated: true };
}

async function pullDetail(call: GithubCall, number: number) {
  assertId(number, "pull request");
  const route = `/pulls/${number}`;
  const [pull, comments, reviews, inline, files] = await Promise.all([
    call(route), collection(call, `/issues/${number}/comments`), collection(call, `${route}/reviews`),
    collection(call, `${route}/comments`), collection(call, `${route}/files`),
  ]);
  return { pull, comments: comments.items, reviews: reviews.items, inline: inline.items, files: files.items, truncated: { comments: comments.truncated, reviews: reviews.truncated, inline: inline.truncated, files: files.truncated } };
}

async function runDetails(call: GithubCall, id: number) {
  assertId(id, "workflow run");
  const detail = await call(`/actions/runs/${id}`) as WorkflowRun;
  const jobs: GithubJob[] = [];
  let total = 0;
  for (let page = 1; page <= 5; page += 1) {
    const batch = await call(`/actions/runs/${id}/jobs?per_page=100&page=${page}`) as { total_count: number; jobs: GithubJob[] };
    total = batch.total_count;
    jobs.push(...batch.jobs);
    if (jobs.length >= total) break;
  }
  if (!/^\.github\/workflows\/[\w./-]+\.ya?ml$/.test(detail.path) || detail.path.includes("..")) throw new GitReviewError(502, "GitHub workflow path is invalid");
  let workflow: { jobs: Record<string, WorkflowJob> };
  try {
    const source = await call(`/contents/${detail.path}?ref=${encodeURIComponent(detail.head_sha)}`) as { content: string };
    if (typeof source.content !== "string") throw new GitReviewError(502, "GitHub workflow content is missing");
    try { workflow = parse(Buffer.from(source.content, "base64").toString("utf8")) as { jobs: Record<string, WorkflowJob> }; }
    catch { throw new GitReviewError(502, "Could not parse GitHub workflow"); }
  } catch (error) {
    if (!(error instanceof GitReviewError) || error.status !== 404) throw error;
    return { run: detail, jobs, dependencies: {}, groups: jobs.map((job) => ({ key: `job-${job.id}`, name: job.name, needs: [], jobIds: [job.id] })), graphWarning: "Workflow file unavailable at this commit; dependencies cannot be shown", truncated: jobs.length < total };
  }
  if (!workflow?.jobs || typeof workflow.jobs !== "object") throw new GitReviewError(502, "GitHub workflow has no jobs");
  return workflowGroups(detail, jobs, workflow.jobs, total);
}

function workflowGroups(detail: WorkflowRun, jobs: GithubJob[], definitions: Record<string, WorkflowJob>, total: number) {
  const dependencies: Record<string, string[]> = {};
  const groups = Object.entries(definitions).map(([key, job]) => {
    const needs = job.needs ? [job.needs].flat() : [];
    dependencies[key] = needs;
    const prefix = (job.name ?? key).split("${{")[0].trim();
    return { key, name: job.name ?? key, needs, jobIds: jobs.filter((item) => item.name === key || item.name.startsWith(`${key} (`) || (prefix && item.name.startsWith(prefix))).map((item) => item.id) };
  });
  const matched = new Set(groups.flatMap((group) => group.jobIds));
  const unmatched = jobs.filter((job) => !matched.has(job.id));
  groups.push(...unmatched.map((job) => ({ key: `job-${job.id}`, name: job.name, needs: [], jobIds: [job.id] })));
  return { run: detail, jobs, dependencies, groups, ...(unmatched.length ? { graphWarning: `${unmatched.length} jobs could not be matched to workflow definitions; their dependencies are not shown` } : {}), truncated: jobs.length < total };
}

async function downloadJobLog(url: string, token: string | undefined, request: typeof fetch): Promise<{ text: string; truncated: boolean }> {
  let first: Response;
  try { first = await request(url, { redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } }); }
  catch { throw new GitReviewError(502, "Could not reach GitHub logs"); }
  if (first.status !== 302 && !first.ok) throw new GitReviewError(502, `GitHub log request failed (HTTP ${first.status})`);
  const location = first.status === 302 ? first.headers.get("location") : null;
  if (first.status === 302) {
    let target: URL;
    try { target = new URL(location!); } catch { throw new GitReviewError(502, "GitHub log redirect is invalid"); }
    if (target.protocol !== "https:" || !target.hostname.endsWith(".blob.core.windows.net")) throw new GitReviewError(502, "GitHub log redirect host is not trusted");
  }
  let download: Response;
  try { download = location ? await request(location, { signal: AbortSignal.timeout(30_000) }) : first; }
  catch { throw new GitReviewError(502, "Could not download GitHub logs"); }
  if (!download.ok || !download.body) throw new GitReviewError(502, `GitHub log download failed (HTTP ${download.status})`);
  const reader = download.body.getReader();
  const chunks: Uint8Array[] = [];
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

export async function createGitHubReview(cwd: string, credentials: Credentials, request: typeof fetch = fetch) {
  const { owner, repo, host } = await githubRepository(cwd, credentials, request);
  const token = tokenFor(credentials, { owner, host });
  const base = `/repos/${owner}/${repo}`;
  const call: GithubCall = (route, method, body) => githubRequest(base, token, request, route, method, body);
  const log = (id: number) => {
    assertId(id, "job");
    return downloadJobLog(`${API}${base}/actions/jobs/${id}/logs`, token, request);
  };
  return {
    repository: { owner, repo },
    pulls: (state: "open" | "closed", page: number) => call(`/pulls?state=${state}&per_page=30&page=${page}&sort=updated&direction=desc`),
    pull: (number: number) => pullDetail(call, number),
    comment: (number: number, body: string) => { assertId(number, "pull request"); assertBody(body); return call(`/issues/${number}/comments`, "POST", { body }); },
    review: (number: number, event: "APPROVE" | "REQUEST_CHANGES", body: string) => { assertId(number, "pull request"); if (event !== "APPROVE" && event !== "REQUEST_CHANGES") throw new GitReviewError(400, "Invalid review decision"); if (event === "REQUEST_CHANGES") assertBody(body); return call(`/pulls/${number}/reviews`, "POST", { event, body }); },
    close: (number: number) => { assertId(number, "pull request"); return call(`/pulls/${number}`, "PATCH", { state: "closed" }); },
    runs: (page: number) => call(`/actions/runs?per_page=30&page=${page}`),
    run: (id: number) => runDetails(call, id),
    log,
  };
}
