# Pi-installed model providers implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Joint Bob discover and run providers installed in the configured personal Pi agent, including `pi-cursor-sdk`.

**Architecture:** Read only package declarations from the configured Pi agent's global `settings.json`; expose their extension code to the model catalog and Pi sessions, while continuing to exclude standalone native extensions and package skills/prompts/themes. Use the Cursor key already saved in Pi's `auth.json`. Bump the supported and default Node runtime to 24 because `pi-cursor-sdk@0.5.4` requires Node 24. In Joint Bob, disable Cursor-native tools and ambient Cursor settings so Cursor turns use Joint Bob's bridged tools and policies.

**Tech Stack:** TypeScript, `@earendil-works/pi-coding-agent`, Node.js, npm, GitHub Actions.

**Spec:** User request and decisions in this conversation (install provider in Pi, have Joint Bob pick it up, raise Node to 24).

## Global constraints

- Preserve strict resource isolation for machine extensions, project packages, skills, prompts, themes, and Cursor's ambient settings.
- Never copy Pi auth credentials into per-user workers; keep credential reads behind the existing node credential hook.
- Cursor runs in Joint Bob must not use Cursor-native tools or ambient Cursor MCP/settings; retain Joint Bob's Pi tool bridge.
- Do not alter the user's existing unrelated working-tree changes.

## Review focus

- Malformed Pi `settings.json` / package declarations and listed-but-uninstalled packages must fail clearly without falling back to native extension discovery. A missing optional `settings.json` is an empty package list; strict mode still suppresses native discovery.
- A package with skills/prompts/themes must not load those resources through Joint Bob's strict mode.
- Custom provider auth must be available from Pi's existing credentials path in both service and worker execution, without exposing credential values.
- A configured model must be selected only after that session's provider extension registers with its own `ModelRuntime`.
- A remote worker must be able to import the configured extension package without receiving the server's full Pi settings or `auth.json`.

---

### Task 1: Raise the supported Joint Bob Node version

**Files:**
- Modify: `package.json`
- Modify: `npm-shrinkwrap.json`
- Modify: `scripts/versions.sh`
- Modify: `scripts/install-node-runtime.sh`
- Modify: `.github/workflows/release.yml`
- Test: `test/node-runtime-version.test.ts`

- [x] Update package engine, default pinned runtime, minimum-version validation, and CI to Node 24.
- [x] Add a test that proves Node 22 is rejected and Node 24 is accepted by the installer version check.
- [x] Run the focused test and package typecheck under Node 24.

### Task 2: Load only packages explicitly installed in Pi

**Files:**
- Modify: `src/harnesses/pi/resource-loader.ts`
- Modify: `src/harnesses/pi/resources.ts`
- Test: `test/pi-provider-extensions.test.ts`

- [x] Test that a global Pi package's extension loads in strict mode while a direct `~/.pi/agent/extensions` extension and package skills do not.
- [x] Extend strict resource settings to merge managed Pi packages with global packages from the configured Pi `settings.json`, filtering Pi-native packages to extensions only.
- [x] Verify existing managed-package and strict-isolation tests.

### Task 3: Discover provider models in Joint Bob

**Files:**
- Create: `src/harnesses/pi/provider-catalog.ts`
- Modify: `src/pi-service.ts`
- Modify: `src/harnesses/pi/runtime.ts`
- Test: `test/pi-provider-extensions.test.ts`

- [x] Add a synthetic provider package fixture; prove its models become available in Joint Bob's catalog after extension binding.
- [x] Keep a no-tools provider-catalog session bound to the catalog `ModelRuntime` so provider registrations and model discovery are initialized before picker queries.
- [x] Ensure `modelIsRunnable`, provider listing, and auth status use the same registered catalog.

### Task 4: Run selected provider extensions in conversation sessions

**Files:**
- Modify: `src/pi-session-core.ts`
- Modify: `src/pi-service.ts`
- Modify: `src/harnesses/pi/remote.ts`
- Modify: `src/pi-worker.ts`
- Modify: `src/provider-profiles/pi.ts`
- Test: `test/pi-provider-extensions.test.ts`

- [x] Test selecting a provider that registers during extension binding, including a saved-session model and a missing-auth failure.
- [x] Bind the session's extension before resolving its requested model; retain the current per-session `ModelRuntime` ownership rule.
- [x] Make installed extension files and dependencies readable to remote Pi workers without copying native settings or `auth.json`.
- [x] Use the existing node credential hook for Pi-stored API keys; do not serialize keys into worker settings or logs.

### Task 5: Apply and verify safe Cursor defaults

**Files:**
- Modify: `src/harnesses/pi` provider initialization
- Test: `test/pi-provider-extensions.test.ts`

- [x] Verify Joint Bob forces `PI_CURSOR_NATIVE_TOOLS=0`, `PI_CURSOR_SETTING_SOURCES=none`, and `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1` when loading the Cursor extension, while keeping its Pi bridge available.
- [x] Run focused provider, strict-isolation, worker, and Node-version tests under Node 24.
- [ ] Complete the full `npm test` suite under Node 24; the attempt timed out after 900 seconds.
- [x] Run `npm run typecheck` under Node 24.
