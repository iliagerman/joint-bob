import { z } from "zod";

const identitySchema = z.object({
  account: z.object({ uuid: z.string().min(1), email: z.string().email() }),
  organization: z.object({ uuid: z.string().min(1) }),
});
export async function claudeOAuthIdentity(accessToken: string, signal: AbortSignal, request: typeof fetch = fetch) {
  const response = await request("https://api.anthropic.com/api/oauth/profile", {
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw new Error("Could not verify the Claude account identity");
  const identity = identitySchema.parse(await response.json());
  return { accountUuid: identity.account.uuid, emailAddress: identity.account.email, organizationUuid: identity.organization.uuid };
}
