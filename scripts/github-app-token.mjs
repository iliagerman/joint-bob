import { createPrivateKey, sign } from "node:crypto";

export async function installationToken({ appId, installationId, privateKey }, request = fetch) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), createPrivateKey(privateKey)).toString("base64url")}`;
  const response = await request(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "joint-bob" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub App token request failed (HTTP ${response.status})`);
  const result = await response.json();
  if (typeof result.token !== "string" || !result.token || !Number.isFinite(Date.parse(result.expires_at))) throw new Error("GitHub App token response is invalid");
  return { token: result.token, expiresAt: Date.parse(result.expires_at) };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  try {
    const result = await installationToken(JSON.parse(input));
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
