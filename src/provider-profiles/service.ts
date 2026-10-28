import { chmod, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { actingAccount, asNode } from "../account-context.js";
import { automationProfileContext } from "./context.js";
import { resolveDataDirectory } from "../data-directory.js";
import { adminAccountId } from "../ownership.js";
import { getProject } from "../store.js";
import { profileLogins } from "./login.js";
import { claudeOAuthIdentity } from "./claude-identity.js";
import { prepareClaudeProfile, readLegacyClaudeCredential, removeLegacyClaudeCredential } from "./claude.js";
import { withProfileAuthority } from "./broker.js";
import { borrowTwinCredential, MIN_TOKEN_VALIDITY_MS, twinLoginHolder, type BorrowedCredential } from "./twin-login.js";
import { accessibleProviderProfile, providerProfile, resolveProviderProfile, type ProfileProvider, type ProviderProfile } from "./store.js";

export type ProfileCredential = NonNullable<ReturnType<typeof readStoredCredential>>;
const runtimes = new Map<string, Promise<ModelRuntime>>();
export function openAIAuthPath(profile: ProviderProfile): string {
  return path.join(resolveDataDirectory(), "provider-profile-auth", profile.id, "auth.json");
}
export async function profileModelRuntime(profile: ProviderProfile): Promise<ModelRuntime> {
  let runtime = runtimes.get(profile.id);
  if (!runtime) {
    runtime = (async () => {
      await mkdir(path.dirname(openAIAuthPath(profile)), { recursive: true, mode: 0o700 });
      await chmod(path.dirname(openAIAuthPath(profile)), 0o700);
      return ModelRuntime.create({ authPath: openAIAuthPath(profile), modelsPath: null, refreshOnCreate: false });
    })();
    runtimes.set(profile.id, runtime);
    runtime.catch(() => runtimes.delete(profile.id));
  }
  return runtime;
}

export async function projectProviderProfile(projectId: string, conversationId: string | undefined, provider: string): Promise<ProviderProfile | undefined> {
  const automation = automationProfileContext();
  const accountId = automation?.accountId ?? actingAccount()?.accountId;
  if (automation?.profileId) {
    const profile = accessibleProviderProfile(automation.accountId, automation.profileId, "automation");
    if (profile.provider !== provider) throw new Error("Selected automation profile does not match the turn's provider");
    return profile;
  }
  if (provider !== "claude" && provider !== "openai-codex") return undefined;
  if (!accountId) return undefined;
  const project = await asNode(() => getProject(projectId));
  if (!project) throw new Error("Project not found");
  const profile = resolveProviderProfile(accountId, provider, { projectId: project.id, workspaceId: project.type!, conversationId }, automation ? "automation" : "interactive")?.profile;
  if (!profile && accountId !== adminAccountId()) throw new Error("Select your own subscription profile on this node. No other user's account was used.");
  return profile;
}

export async function persistOpenAIProfileCredential(profile: ProviderProfile, credential: Extract<ProfileCredential, { type: "oauth" }>): Promise<void> {
  await persistProfileCredential(profile, credential);
}
async function persistProfileCredential(profile: ProviderProfile, credential: Extract<ProfileCredential, { type: "oauth" }>): Promise<void> {
  const providerId = profile.provider === "claude" ? "anthropic" : "openai-codex";
  await mkdir(path.dirname(openAIAuthPath(profile)), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(openAIAuthPath(profile)), 0o700);
  const runtime = await ModelRuntime.create({ authPath: openAIAuthPath(profile), modelsPath: null, refreshOnCreate: false });
  const provider = runtime.getProvider(providerId);
  if (!provider?.auth?.oauth) throw new Error("Provider login unavailable");
  runtime.registerNativeProvider({ ...provider, auth: { ...provider.auth, oauth: { ...provider.auth.oauth, login: async () => credential } } });
  try {
    await runtime.login(providerId, "oauth", { signal: new AbortController().signal, notify: () => {}, prompt: async () => { throw new Error("Unexpected provider prompt"); } });
  } catch {
    const stored = readStoredCredential(providerId, openAIAuthPath(profile));
    if (stored?.type !== "oauth" || stored.access !== credential.access || stored.refresh !== credential.refresh) throw new Error("Could not save the profile on this node");
  }
  await chmod(openAIAuthPath(profile), 0o600);
}

// Called only under the authority gate. File existence (including a signed-out
// empty store) is authoritative; never resurrect a legacy refresh credential.
async function migrateClaudeProfile(profile: ProviderProfile): Promise<void> {
  let exists = false;
  try { await stat(openAIAuthPath(profile)); exists = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!exists) {
    const native = await readLegacyClaudeCredential(profile);
    if (!native) return;
    if (typeof native.accessToken !== "string" || !native.accessToken || typeof native.refreshToken !== "string" || !native.refreshToken || !Number.isFinite(native.expiresAt)) throw new Error("Invalid legacy Claude credential");
    await persistProfileCredential(profile, { type: "oauth", access: native.accessToken, refresh: native.refreshToken, expires: native.expiresAt });
  }
  await chmod(openAIAuthPath(profile), 0o600);
  await removeLegacyClaudeCredential(profile);
}

/** Only the access token crosses into a turn's execution runtime. */
export async function claudeProfileAccessToken(profile: ProviderProfile): Promise<string> {
  if (profile.provider !== "claude") throw new Error("Expected Claude profile");
  return (await localProfileCredential(profile) ?? await borrowTwinCredential(profile)).access;
}

/**
 * This node's own sign-in, refreshed under its lock to stay valid for ten minutes, or
 * undefined when the user never signed in here (or signed out). Twins borrow from this.
 */
export async function localProfileCredential(profile: ProviderProfile): Promise<ProfileOAuthCredential | undefined> {
  const message = `Sign in to ${profile.label} again on this node. No other account was used.`;
  const providerId = profile.provider === "claude" ? "anthropic" : "openai-codex";
  const refresh = async () => {
    if (readStoredCredential(providerId, openAIAuthPath(profile))?.type !== "oauth") return undefined;
    try {
      await (await profileModelRuntime(profile)).getAuth(providerId, { minOAuthValidityMs: MIN_TOKEN_VALIDITY_MS, env: {} });
      const fresh = readStoredCredential(providerId, openAIAuthPath(profile));
      if (fresh?.type !== "oauth" || !fresh.access || fresh.expires < Date.now() + MIN_TOKEN_VALIDITY_MS) throw new Error(message);
      return fresh;
    } catch { throw new Error(message); }
  };
  if (profile.provider === "openai-codex") return refresh();
  return withProfileAuthority(openAIAuthPath(profile), async () => {
    try { await migrateClaudeProfile(profile); } catch { throw new Error(message); }
    return refresh();
  });
}
type ProfileOAuthCredential = Extract<ProfileCredential, { type: "oauth" }>;

export async function startProfileLogin(owner: string, id: string) {
  const profile = providerProfile(owner, id);
  if (profile.provider === "claude") {
    const current = await profileLoginState(profile);
    if (current.signedIn) throw new Error("Sign out before replacing this Claude profile login");
    if (current.message !== "Sign in on this node") throw new Error(current.message);
  }
  return profileLogins.start(owner, id, profile.provider, async (interaction) => {
    const runtime = await profileModelRuntime(profile);
    const provider = runtime.getProvider(profile.provider === "openai-codex" ? "openai-codex" : "anthropic");
    if (!provider?.auth?.oauth) throw new Error("Provider login unavailable");
    const credential = await provider.auth.oauth.login({ ...interaction, signal: interaction.signal! });
    if (profile.provider === "openai-codex") return credential;
    const identity = await claudeOAuthIdentity(credential.access, interaction.signal!);
    return { ...credential, claudeIdentity: identity };
  }, async (credential) => {
    if (credential.type !== "oauth") throw new Error("Expected subscription login");
    if (profile.provider === "openai-codex") {
      await persistOpenAIProfileCredential(profile, credential);
    } else {
      await withProfileAuthority(openAIAuthPath(profile), async () => {
        await persistProfileCredential(profile, credential);
        await removeLegacyClaudeCredential(profile);
        await prepareClaudeProfile(profile, credential.claudeIdentity as Awaited<ReturnType<typeof claudeOAuthIdentity>>);
      });
    }
  });
}

/** The SDK's file lock serializes renewal across sessions and processes. Never use ambient keys. */
export async function refreshedProfileCredential(profile: ProviderProfile): Promise<ProfileOAuthCredential | BorrowedCredential> {
  if (profile.provider !== "openai-codex") throw new Error("This profile is not an OpenAI profile");
  return await localProfileCredential(profile) ?? borrowTwinCredential(profile);
}

/** Where a turn on this node would get the profile's token: here, from a twin, or nowhere. */
export async function profileAvailability(profile: ProviderProfile): Promise<{ signedIn: boolean; twin: string | null; message: string }> {
  const local = await profileLoginState(profile);
  if (local.signedIn || local.message !== "Sign in on this node") return { ...local, twin: null };
  const { holder, unchecked } = await twinLoginHolder(profile);
  if (holder) return { signedIn: false, twin: holder, message: `Uses the sign-in on ${holder}. Turns here borrow short-lived tokens from it.` };
  const note = unchecked.length ? ` ${unchecked.join(", ")} could not be checked.` : "";
  return { signedIn: false, twin: null, message: `Sign in on this node${note}` };
}

export async function profileLoginState(profile: ProviderProfile): Promise<{ signedIn: boolean; message: string }> {
  if (profile.provider === "openai-codex") {
    const credential = readStoredCredential("openai-codex", openAIAuthPath(profile));
    return { signedIn: credential?.type === "oauth", message: credential?.type === "oauth" ? "Signed in. Tokens refresh automatically on this node." : "Sign in on this node" };
  }
  try {
    return await withProfileAuthority(openAIAuthPath(profile), async () => {
      await migrateClaudeProfile(profile);
      const signedIn = readStoredCredential("anthropic", openAIAuthPath(profile))?.type === "oauth";
      return { signedIn, message: signedIn ? "Signed in. Tokens refresh automatically on this node." : "Sign in on this node" };
    });
  } catch { return { signedIn: false, message: "Claude login status unavailable on this node" }; }
}

export async function logoutProfile(profile: ProviderProfile): Promise<void> {
  if (profile.provider === "claude") {
    await withProfileAuthority(openAIAuthPath(profile), async () => {
      await (await profileModelRuntime(profile)).logout("anthropic");
      // Keep the empty canonical file as a tombstone against legacy reseeding.
      await removeLegacyClaudeCredential(profile);
      await prepareClaudeProfile(profile);
      runtimes.delete(profile.id);
    });
  } else {
    await (await profileModelRuntime(profile)).logout("openai-codex");
    await rm(path.dirname(openAIAuthPath(profile)), { recursive: true, force: true });
    runtimes.delete(profile.id);
  }
}
