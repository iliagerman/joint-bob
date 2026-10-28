import type { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";

type Credential = NonNullable<ReturnType<typeof readStoredCredential>>;
type Interaction = Parameters<ModelRuntime["login"]>[2];
export type LoginDriver = (interaction: Interaction) => Promise<Credential>;
export interface ProfileLoginStatus {
  state: "waiting" | "complete" | "failed" | "cancelled";
  url?: string;
  message: string;
  prompt?: { type: string; message: string; options?: readonly { id: string; label: string }[] };
  deviceCode?: string;
}
interface Login {
  owner: string; provider: string; controller: AbortController; status: ProfileLoginStatus;
  answer?: (value: string) => void; timeout: NodeJS.Timeout; persisting?: boolean;
}

/** OAuth interaction state only. Tokens and submitted authorization codes are never status fields. */
export class ProfileLogins {
  private readonly logins = new Map<string, Login>();

  start(owner: string, id: string, provider: string, driver: LoginDriver, persist: (credential: Credential) => Promise<void>): ProfileLoginStatus {
    if ([...this.logins.values()].some((login) => login.provider === provider && login.status.state === "waiting")) throw new Error("A login for this provider is already in progress on this node");
    const controller = new AbortController();
    const login: Login = { owner, provider, controller, status: { state: "waiting", message: "Starting sign-in on this node" }, timeout: setTimeout(() => this.cancel(owner, id), 15 * 60_000) };
    login.timeout.unref();
    this.logins.set(id, login);
    void this.run(id, login, driver, persist);
    return this.status(owner, id)!;
  }

  private async run(id: string, login: Login, driver: LoginDriver, persist: (credential: Credential) => Promise<void>): Promise<void> {
    try {
      const credential = await driver({ signal: login.controller.signal,
        notify: (event) => {
          if (login.controller.signal.aborted) return;
          if (event.type === "auth_url") login.status.url = event.url;
          if (event.type === "device_code") { login.status.url = event.verificationUri; login.status.deviceCode = event.userCode; }
          // Provider response bodies and progress messages can contain sensitive values.
          login.status.message = "Complete sign-in with the provider, then return here";
        },
        prompt: (prompt) => new Promise<string>((resolve, reject) => {
          const signal = prompt.signal ? AbortSignal.any([prompt.signal, login.controller.signal]) : login.controller.signal;
          if (signal.aborted) { reject(new Error("Login cancelled")); return; }
          const abort = () => { login.answer = undefined; delete login.status.prompt; reject(new Error("Login cancelled")); };
          signal.addEventListener("abort", abort, { once: true });
          login.status.prompt = { type: prompt.type, message: prompt.message, ...(prompt.type === "select" ? { options: prompt.options.map(({ id, label }) => ({ id, label })) } : {}) };
          login.answer = (answer) => { signal.removeEventListener("abort", abort); login.answer = undefined; delete login.status.prompt; resolve(answer); };
        }),
      });
      if (login.controller.signal.aborted || this.logins.get(id) !== login) return;
      login.persisting = true;
      login.status.message = "Saving sign-in on this node";
      await persist(credential);
      login.status = { state: "complete", message: "Signed in on this node" };
    } catch {
      login.status = login.controller.signal.aborted
        ? { state: "cancelled", message: "Sign-in cancelled" }
        : { state: "failed", message: "Sign-in failed on this node. Start again and complete the provider's login." };
    } finally {
      clearTimeout(login.timeout);
      login.answer = undefined;
      login.controller.abort();
    }
  }

  status(owner: string, id: string): ProfileLoginStatus | undefined {
    const login = this.logins.get(id);
    if (!login || login.owner !== owner) return undefined;
    return structuredClone(login.status);
  }
  answer(owner: string, id: string, answer: string): void {
    const login = this.logins.get(id);
    if (!login || login.owner !== owner || login.status.state !== "waiting" || !login.answer) throw new Error("This profile has no pending sign-in prompt");
    login.answer(answer);
  }
  cancel(owner: string, id: string): void {
    const login = this.logins.get(id);
    if (!login || login.owner !== owner) throw new Error("Profile login not found");
    if (login.status.state !== "waiting") throw new Error("No sign-in is in progress");
    if (login.persisting) throw new Error("Sign-in is finishing on this node");
    login.status = { state: "cancelled", message: "Sign-in cancelled" };
    login.controller.abort();
  }
}
export const profileLogins = new ProfileLogins();
