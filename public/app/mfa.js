import { api } from "./api.js";
import { toast } from "./shell.js";

const dialog = document.querySelector("#mfaDialog");
const form = document.querySelector("#mfaForm");
const message = document.querySelector("#mfaMessage");
const errorMessage = document.querySelector("#mfaError");
const password = document.querySelector("#mfaPasswordInput");
const code = document.querySelector("#mfaCodeInput");
const setupKey = document.querySelector("#mfaSetupKey");
const recoveryCodes = document.querySelector("#mfaRecoveryCodes");
const submit = document.querySelector("#mfaSubmitButton");
const cancel = document.querySelector("#mfaCancelButton");
const disable = document.querySelector("#mfaDisableButton");
const settingsButton = document.querySelector("#settingsMfaButton");
const settingsStatus = document.querySelector("#settingsMfaStatus");
let mode = "setup";
let busy = false;

function renderStatus(status) {
  settingsStatus.textContent = status.enabled ? `Enabled. ${status.recoveryCodesRemaining} recovery codes remaining.` : "Not enabled. Sign-in uses your password only.";
  settingsButton.textContent = status.enabled ? "Manage MFA" : "Set up MFA";
}

export async function loadMfaSettings() {
  const status = await api("/api/auth/mfa");
  renderStatus(status);
  return status;
}

function showError(text = "") {
  errorMessage.textContent = text;
  errorMessage.hidden = !text;
}

function setMode(next) {
  mode = next;
  password.required = next === "setup" || next === "manage";
  document.querySelector("#mfaPasswordLabel").hidden = !password.required;
  code.required = next === "confirm" || next === "manage";
  document.querySelector("#mfaCodeLabel").hidden = !code.required;
  document.querySelector("#mfaCodeText").textContent = next === "confirm" ? "6-digit authenticator code" : "Authenticator or recovery code";
  code.inputMode = next === "confirm" ? "numeric" : "text";
  document.querySelector("#mfaSetup").hidden = next !== "confirm";
  document.querySelector("#mfaRecovery").hidden = next !== "recovery";
  disable.hidden = next !== "manage";
  cancel.hidden = next === "recovery";
  submit.textContent = { setup: "Start setup", confirm: "Enable MFA", manage: "Replace recovery codes", recovery: "I saved these codes" }[next];
  message.textContent = {
    setup: "Use any offline TOTP authenticator. Confirm your password to create a setup key for your account on this node.",
    confirm: "Add the key to your authenticator, then enter its code to enable MFA. Your other sessions will be signed out.",
    manage: "Your password and a fresh code are required. Replacing recovery codes invalidates the old set. Disabling MFA returns to password-only sign-in. Either action signs out your other sessions.",
    recovery: "MFA is enabled. These ten recovery codes are shown only once.",
  }[next];
}

settingsButton.addEventListener("click", async () => {
  settingsButton.disabled = true;
  try {
    const status = await loadMfaSettings();
    form.reset();
    showError();
    setMode(status.enabled ? "manage" : "setup");
    dialog.showModal();
    password.focus();
  } catch (error) { toast(error.message); }
  finally { settingsButton.disabled = false; }
});

async function perform(action) {
  if (busy) return;
  if (mode === "recovery") { closeDialog(); return; }
  if (!form.reportValidity()) return;
  busy = true;
  for (const button of [submit, cancel, disable]) button.disabled = true;
  showError();
  try {
    if (mode === "setup") {
      const result = await api("/api/auth/mfa/setup", { method: "POST", body: JSON.stringify({ currentPassword: password.value }) });
      if (!dialog.open) return;
      password.value = "";
      setupKey.value = result.secret;
      setMode("confirm");
      code.focus();
      return;
    }
    const result = await api(`/api/auth/mfa/${mode === "confirm" ? "confirm" : action}`, {
      method: "POST",
      body: JSON.stringify({ ...(mode === "manage" ? { currentPassword: password.value } : {}), code: code.value.trim() }),
    });
    if (!dialog.open) return;
    password.value = "";
    code.value = "";
    setupKey.value = "";
    if (result.recoveryCodes) {
      recoveryCodes.value = result.recoveryCodes.join("\n");
      setMode("recovery");
      renderStatus({ enabled: true, recoveryCodesRemaining: result.recoveryCodes.length });
      recoveryCodes.focus();
    } else {
      renderStatus({ enabled: false, recoveryCodesRemaining: 0 });
      closeDialog();
    }
  } catch (error) { showError(error.message); }
  finally {
    busy = false;
    for (const button of [submit, cancel, disable]) button.disabled = false;
  }
}

async function cancelSetup() {
  if (busy || mode === "recovery") return;
  if (mode === "confirm") {
    busy = true;
    try { await api("/api/auth/mfa/setup", { method: "DELETE" }); }
    catch (error) { showError(error.message); return; }
    finally { busy = false; }
  }
  closeDialog();
}

function closeDialog() {
  clearMfaSecrets();
  dialog.close();
}

form.addEventListener("submit", event => { event.preventDefault(); void perform("recovery-codes"); });
disable.addEventListener("click", () => { void perform("disable"); });
cancel.addEventListener("click", () => { void cancelSetup(); });
dialog.addEventListener("cancel", event => { event.preventDefault(); void cancelSetup(); });
export function clearMfaSecrets() {
  // Never retain setup keys, recovery codes, or passwords after the modal is gone.
  for (const input of [password, code, setupKey, recoveryCodes]) input.value = "";
  showError();
}
dialog.addEventListener("close", clearMfaSecrets);
