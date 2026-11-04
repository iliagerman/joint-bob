import { chmod, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ModelRuntime, readStoredCredential, getAgentDir } from "../pi-sdk.js";
import { actingAccount, asNode } from "../account-context.js";
import { automationProfileContext, poolProfileContext } from "./context.js";
import { resolveDataDirectory } from "../data-directory.js";
import { adminAccountId } from "../ownership.js";
import { getProject } from "../store.js";
import { profileLogins } from "./login.js";
import { claudeOAuthIdentity } from "./claude-identity.js";
import { prepareClaudeProfile, readLegacyClaudeCredential, removeLegacyClaudeCredential } from "./claude.js";
import { withProfileAuthority } from "./broker.js";
import { borrowClusterCredential, borrowTwinCredential, MIN_TOKEN_VALIDITY_MS, twinLoginHolder, type BorrowedCredential } from "./twin-login.js";
import { accessibleProviderProfile, listProviderProfiles, machineSignInChosen, providerProfile, resolveProviderProfile, type ProfileProvider, type ProfileScope, type ProviderProfile } from "./store.js";

export { createSubscriptionPool, deleteSubscriptionPool, getSubscriptionPool, listSubscriptionPools, poolCandidates, resolveSubscriptionChoice, setSubscriptionPoolChoice, updateSubscriptionPool } from "./pools.js";

export type ProfileCredential = NonNullable<ReturnType<typeof readStoredCredential>>;
const runtimes = new Map<string, Promise<ModelRuntime>>();
const catalogs = new Map<string, import("../harnesses/pi/provider-catalog.js").PiProviderCatalog>();
export function openAIAuthPath(profile: ProviderProfile): string {
  return path.join(resolveDataDirectory(), "provider-profile-auth", profile.id, "auth.json");
}
export async function profileModelRuntime(profile: ProviderProfile): Promise<ModelRuntime> {
  let runtime = runtimes.get(profile.id);
  if (!runtime) {
    runtime = (async () => {
      await mkdir(path.dirname(openAIAuthPath(profile)), { recursive: true, mode: 0o700 });
      await chmod(path.dirname(openAIAuthPath(profile)), 0o700);
      const modelRuntime = await ModelRuntime.create({ authPath: openAIAuthPath(profile), modelsPath: null, refreshOnCreate: false });
      if (profile.provider === "pi") {
        const { createPiProviderCatalog } = await import("../harnesses/pi/provider-catalog.js");
        const { agentResourcePaths, piAgentResourcePaths } = await import("../agent-resources.js");
        const { getSettings } = await import("../settings.js");
        const { protectPiProfileRuntime } = await import("./pi-auth.js");
        const catalog = await createPiProviderCatalog(modelRuntime, { agentDir: getAgentDir(), strictResourceIsolation: getSettings().strictResourceIsolation,
          packagesFile: agentResourcePaths().piPackages, extensionPaths: piAgentResourcePaths().extensions });
        catalogs.set(profile.id, catalog);
        await protectPiProfileRuntime(modelRuntime, () => true, { authPath: openAIAuthPath(profile) });
      }
      return modelRuntime;
    })();
    runtimes.set(profile.id, runtime);
    runtime.catch(() => runtimes.delete(profile.id));
  }
  const models = await runtime;
  if (profile.provider === "pi") await catalogs.get(profile.id)!.refreshIfChanged();
  return models;
}

export async function bootstrapPiProfile(projectId: string, conversationId: string | undefined): Promise<ProviderProfile | undefined> {
  const pool = poolProfileContext();
  if (pool) return pool.provider === "pi" ? projectProviderProfile(projectId, conversationId, "", "pi") : undefined;
  const automation = automationProfileContext();
  if (automation?.profileId) {
    const profile = accessibleProviderProfile(automation.accountId, automation.profileId, "automation");
    return profile.provider === "pi" ? profile : undefined;
  }
  const accountId = automation?.accountId ?? actingAccount()?.accountId;
  if (!accountId) return undefined;
  const project = await asNode(() => getProject(projectId));
  if (!project) throw new Error("Project not found");
  const { resolveSubscriptionChoice } = await import("./pools.js");
  const choice = resolveSubscriptionChoice(accountId, "pi", await projectScope(project.id, project.type!, conversationId), automation ? "automation" : "interactive");
  return choice?.kind === "profile" ? choice.profile : undefined;
}

export async function projectProviderProfile(projectId: string, conversationId: string | undefined, provider: string, engine: "claude" | "pi" | "kiro" = "claude"): Promise<ProviderProfile | undefined> {
  const targetProvider = provider === "anthropic" ? "claude" : provider;
  const poolProfile = poolProfileContext();
  if (poolProfile) {
    if (poolProfile.provider === "pi" && poolProfile.clusterId) {
      const { getClusterNode } = await import("../cluster.js");
      if (poolProfile.poolOwnerNodeId !== (await getClusterNode()).id) {
        const { PoolAttemptFailure } = await import("./pool-execution.js");
        throw new PoolAttemptFailure("unavailable", false, "Pi profile credentials stay on their configured node; this pool member is unavailable here");
      }
    }
    if (poolProfile.provider !== targetProvider && !(engine === "pi" && poolProfile.provider === "pi")) throw new Error("Selected pool profile does not match the turn's provider");
    return poolProfile.profile ?? { id: poolProfile.profileId, owner: "", label: poolProfile.label, provider: poolProfile.provider, createdAt: "", shared: false };
  }
  const automation = automationProfileContext();
  const accountId = automation?.accountId ?? actingAccount()?.accountId;
  if (automation?.profileId) {
    const profile = accessibleProviderProfile(automation.accountId, automation.profileId, "automation");
    if (profile.provider !== targetProvider && !(engine === "pi" && profile.provider === "pi")) throw new Error("Selected automation profile does not match the turn's provider");
    return profile;
  }
  if (!accountId) return undefined;
  const project = await asNode(() => getProject(projectId));
  if (!project) throw new Error("Project not found");
  const scope = await projectScope(project.id, project.type!, conversationId);
  if (engine === "pi") {
    const selected = resolveProviderProfile(accountId, "pi", scope, automation ? "automation" : "interactive");
    if (selected) return selected.profile;
  }
  const subscription = targetProvider === "claude" || targetProvider === "openai-codex" || (engine === "kiro" && targetProvider === "kiro");
  // This machine's own sign-in chosen for the provider means no profile at all, Pi profiles included.
  const machine = subscription && machineSignInChosen(accountId, targetProvider as ProfileProvider, scope);
  const profile = machine ? undefined : (subscription ? resolveProviderProfile(accountId, targetProvider, scope, automation ? "automation" : "interactive")?.profile : undefined)
    ?? (engine === "pi" ? onlyPiProfileHolding(accountId, provider) : undefined);
  if (!subscription) return profile;
  if (!profile && accountId !== adminAccountId()) throw new Error("Select your own subscription profile on this node. No other user's account was used.");
  return profile;
}
/** Where a turn runs, including the clusters its project is shared through for cluster choices. */
async function projectScope(projectId: string, workspaceId: string, conversationId: string | undefined): Promise<ProfileScope> {
  const [{ clusterV2Database }, { getClusterNode }, { projectClusterIds }] = await Promise.all([import("../cluster-v2-store.js"), import("../cluster.js"), import("./pool-sharing.js")]);
  return { projectId, workspaceId, conversationId, clusterIds: projectClusterIds(await clusterV2Database(), (await getClusterNode()).id, projectId) };
}
/** A single Pi profile serves a Pi turn whose provider it holds; it is never guessed for a provider it lacks. */
function onlyPiProfileHolding(owner: string, provider: string): ProviderProfile | undefined {
  const candidates = listProviderProfiles(owner).filter((profile) => profile.provider === "pi" && !profile.shared);
  return candidates.length === 1 && readStoredCredential(provider, openAIAuthPath(candidates[0])) ? candidates[0] : undefined;
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
  return (await profileAccessCredential(profile)).access;
}

/**
 * This node's own sign-in, refreshed under its lock to stay valid for ten minutes, or
 * undefined when the user never signed in here (or signed out). Twins borrow from this.
 */
export async function localProfileCredential(profile: ProviderProfile): Promise<ProfileOAuthCredential | undefined> {
  if (profile.provider === "kiro") throw new Error("Kiro profiles are standalone; their credentials never leave this node");
  if (profile.provider === "pi") throw new Error("Pi profile credentials stay on this node; OAuth token borrowing is unavailable");
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
  if (profile.provider === "kiro") return (await import("../kiro-profiles/native.js")).startKiroProfileLogin(profile);
  if (profile.provider === "pi") throw new Error("Choose a provider and login method for this Pi profile");
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
export async function profileAccessCredential(profile: ProviderProfile): Promise<ProfileOAuthCredential | BorrowedCredential> {
  const pool = poolProfileContext();
  if (pool?.clusterId) return borrowClusterCredential(profile, pool);
  return await localProfileCredential(profile) ?? borrowTwinCredential(profile);
}

export async function refreshedProfileCredential(profile: ProviderProfile): Promise<ProfileOAuthCredential | BorrowedCredential> {
  if (profile.provider !== "openai-codex") throw new Error("This profile is not an OpenAI profile");
  return profileAccessCredential(profile);
}

/** Where a turn on this node would get the profile's token: here, from a twin, or nowhere. */
export async function profileAvailability(profile: ProviderProfile): Promise<{ signedIn: boolean; twin: string | null; message: string }> {
  const local = await profileLoginState(profile);
  if (profile.provider === "pi" || profile.provider === "kiro") return { ...local, twin: null };
  if (local.signedIn || local.message !== "Sign in on this node") return { ...local, twin: null };
  const { holder, unchecked } = await twinLoginHolder(profile);
  if (holder) return { signedIn: false, twin: holder, message: `Uses the sign-in on ${holder}. Turns here borrow short-lived tokens from it.` };
  const note = unchecked.length ? ` ${unchecked.join(", ")} could not be checked.` : "";
  return { signedIn: false, twin: null, message: `Sign in on this node${note}` };
}

export async function profileLoginState(profile: ProviderProfile): Promise<{ signedIn: boolean; message: string }> {
  if (profile.provider === "kiro") return (await import("../kiro-profiles/native.js")).kiroProfileLoginState(profile);
  if (profile.provider === "pi") {
    const runtime = await profileModelRuntime(profile);
    const entries = await runtime.listCredentials();
    return { signedIn: entries.length > 0, message: entries.length ? `Configured on this node: ${entries.map((entry) => runtime.getProvider(entry.providerId)?.name ?? entry.providerId).join(", ")}` : "Sign in on this node" };
  }
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
  if (profile.provider === "kiro") return (await import("../kiro-profiles/native.js")).logoutKiroProfile(profile);
  if (profile.provider === "claude") {
    await withProfileAuthority(openAIAuthPath(profile), async () => {
      await (await profileModelRuntime(profile)).logout("anthropic");
      // Keep the empty canonical file as a tombstone against legacy reseeding.
      await removeLegacyClaudeCredential(profile);
      await prepareClaudeProfile(profile);
      runtimes.delete(profile.id);
    });
  } else {
    const runtime = await profileModelRuntime(profile);
    const providers = profile.provider === "pi" ? (await runtime.listCredentials()).map((entry) => entry.providerId) : ["openai-codex"];
    for (const provider of providers) await runtime.logout(provider);
    await rm(path.dirname(openAIAuthPath(profile)), { recursive: true, force: true });
    catalogs.get(profile.id)?.dispose();
    catalogs.delete(profile.id);
    runtimes.delete(profile.id);
  }
}
