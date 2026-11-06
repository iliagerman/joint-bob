import { ModelRuntime } from "../pi-sdk.js";
import type { PiCoreHooks } from "../pi-session-core.js";
import type { ProfileCredential } from "./service.js";
import { protectPiProfileRuntime } from "./pi-auth.js";

/** One runtime per session; requests ask the node to refresh the pinned profile under its lock. */
export async function createSessionModelRuntime(
  read: (provider: string) => Promise<ProfileCredential | undefined>,
  list: () => Promise<Array<{ providerId: string; type: ProfileCredential["type"] }>>,
  isolated: () => boolean | Promise<boolean> = () => false,
): Promise<ModelRuntime> {
  /** Placeholder token → the relay proxy that accepts it (relay-proxy.ts); the relay keeps the real sign-in. */
  const proxied = new Map<string, string>();
  const readCredential = async (provider: string) => {
    const credential = await read(provider);
    if (credential?.type === "oauth" && typeof credential.proxyBaseUrl === "string") proxied.set(credential.access, credential.proxyBaseUrl);
    return credential;
  };
  const credentials = {
      read: readCredential,
      list,
      modify: async (provider: string) => {
        const credential = await readCredential(provider);
        if (credential?.type === "oauth" && credential.expires <= Date.now()) throw new Error("Sign in to the selected profile again on this node");
        return credential;
      },
      delete: async () => { throw new Error("Manage subscription sign-ins in Settings > Connections"); },
  };
  const runtime = await ModelRuntime.create({ credentials,
    // Creation restores the node's cached model catalog (no network). Skipping it left only
    // built-in models, so a model Pi had since learned about was "not found" in Joint Bob.
  });
  await protectPiProfileRuntime(runtime, isolated, { credentials });
  const auth = runtime.getAuth.bind(runtime);
  runtime.getAuth = async (provider: string | Parameters<ModelRuntime["getAuth"]>[0], options?: Parameters<ModelRuntime["getAuth"]>[1]) => {
    // Both overloads (provider id or model) are forwarded as the caller gave them.
    const result = typeof provider === "string" ? await auth(provider, options) : await auth(provider, options);
    const baseUrl = result?.auth.apiKey ? proxied.get(result.auth.apiKey) : undefined;
    return baseUrl ? { ...result!, auth: { ...result!.auth, baseUrl } } : result;
  };
  return runtime;
}

export type ProfileModelHooks = Pick<PiCoreHooks, "modelCredential" | "modelCredentialList">;
