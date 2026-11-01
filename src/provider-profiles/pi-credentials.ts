import { chmod } from "node:fs/promises";
import { readStoredCredential } from "../pi-sdk.js";
import { profileLogins, type ProfileLoginStatus } from "./login.js";
import { openAIAuthPath, profileModelRuntime, type ProfileCredential } from "./service.js";
import { providerProfile, type ProviderProfile } from "./store.js";

function assertPiProfile(profile: ProviderProfile): void {
  if (profile.provider !== "pi") throw new Error("Expected Pi profile");
}

export async function piProfileProviders(profile: ProviderProfile) {
  assertPiProfile(profile);
  const runtime = await profileModelRuntime(profile);
  const configured = new Set((await runtime.listCredentials()).map((entry) => entry.providerId));
  return runtime.getProviders().map((provider) => ({
    id: provider.id, name: provider.name,
    methods: [
      ...(provider.auth.apiKey?.login ? [{ id: "api_key", label: provider.auth.apiKey.name }] : []),
      ...(provider.auth.oauth ? [{ id: "oauth", label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name }] : []),
    ],
    configured: configured.has(provider.id),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function startPiProfileLogin(owner: string, profileId: string, providerId: string, methodId: string): Promise<ProfileLoginStatus> {
  const profile = providerProfile(owner, profileId);
  assertPiProfile(profile);
  const methods = await piProfileProviders(profile);
  if (!methods.find((provider) => provider.id === providerId)?.methods.some((method) => method.id === methodId)) throw new Error("Provider login method unavailable");
  const runtime = await profileModelRuntime(profile);
  const provider = runtime.getProvider(providerId)!;
  return profileLogins.start(owner, profile.id, providerId, (interaction) => {
    const prompt = { ...interaction, signal: interaction.signal! };
    return methodId === "oauth" ? provider.auth.oauth!.login(prompt) : provider.auth.apiKey!.login!(prompt);
  }, async (credential) => {
    // Persist only after ProfileLogins has crossed its non-cancellable saving boundary.
    const auth = credential.type === "oauth"
      ? { ...provider.auth, oauth: { ...provider.auth.oauth!, login: async () => credential } }
      : { ...provider.auth, apiKey: { ...provider.auth.apiKey!, login: async () => credential } };
    runtime.registerNativeProvider({ ...provider, auth });
    try {
      await runtime.login(providerId, credential.type, { signal: new AbortController().signal, notify: () => {}, prompt: async () => { throw new Error("Unexpected provider prompt"); } });
      await chmod(openAIAuthPath(profile), 0o600);
    } finally { runtime.registerNativeProvider(provider); }
  });
}

export async function removePiProfileProvider(profile: ProviderProfile, providerId: string): Promise<void> {
  assertPiProfile(profile);
  const runtime = await profileModelRuntime(profile);
  if (!runtime.getProvider(providerId)) throw new Error("Provider not found");
  await runtime.logout(providerId);
}

/** Read only the selected profile, refreshing OAuth through its isolated runtime. */
export async function piProfileCredential(profile: ProviderProfile, providerId: string): Promise<ProfileCredential | undefined> {
  assertPiProfile(profile);
  const credential = readStoredCredential(providerId, openAIAuthPath(profile));
  if (!credential) return undefined;
  try {
    await (await profileModelRuntime(profile)).getAuth(providerId, { env: {}, minOAuthValidityMs: 10 * 60_000 });
    return readStoredCredential(providerId, openAIAuthPath(profile));
  } catch {
    throw new Error(`Sign in to ${profile.label} for ${providerId} again on this node. No other account was used.`);
  }
}
