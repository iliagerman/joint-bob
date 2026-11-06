// The first time this node makes a story or an Activity overview, the viewer picks the voice that narrates it.
// The choice is saved in this node's settings (Settings → Activity overview, where it can be changed), so it is asked once.
import { api } from "./api.js";
import { projectGitUrl } from "./project-git-url.js";
import { chooseOption, toast } from "./shell.js";
import { state } from "./state.js";

const LOCAL_INSTALL = "It installs once, about 500 MB, and needs no key.";

/** This node's story settings, after asking for a voice if none was chosen yet. Null when the viewer cancels. */
export async function voiceForThisNode() {
  const { settings } = await api("/api/story-settings");
  if (settings.voiceChosen) return settings;
  // This computer narrates whatever the project's node wrote, so its own Kokoro and the project's ElevenLabs key are offered.
  const target = { projectId: state.activeProjectId, nodeId: state.activeNodeId, taskId: state.activeTaskId };
  const url = (route, params) => projectGitUrl(target, route, params);
  const [local, eleven] = await Promise.all([api(url("story-voice", { voiceProvider: "kokoro" })), api(url("story-voice", { voiceProvider: "elevenlabs" }))]);
  const choice = await chooseOption({
    eyebrow: "Narration", title: "Which voice should narrate?", confirmLabel: "Use this voice",
    message: "Stories and Activity overviews are spoken by two hosts. Your choice is saved on this computer; change it later in Settings → Activity overview.",
    options: [
      { value: "kokoro", label: "Open-source voice (Kokoro)", disabled: !local.local.allowed,
        hint: !local.local.allowed ? local.local.reason : local.local.installed ? "Free and private. Already installed on this computer." : `Free and private. ${LOCAL_INSTALL}` },
      { value: "elevenlabs", label: "ElevenLabs", hint: eleven.available ? "Uses this project's ElevenLabs account." : eleven.reason },
      { value: "none", label: "No voice", hint: "Play silently, with captions." },
    ],
  });
  if (!choice) return null;
  const chosen = { ...settings, narrate: choice !== "none", voiceProvider: choice === "none" ? settings.voiceProvider : choice, voiceChosen: true };
  const saved = (await api("/api/story-settings", { method: "PUT", body: JSON.stringify(chosen) })).settings;
  if (choice === "kokoro" && !local.local.installed && !local.local.installing) {
    await api(url("story-voice/install"), { method: "POST" });
    toast(`Installing the open-source voice. ${LOCAL_INSTALL} Until it is ready, narration is silent and says so.`, 9000);
  }
  return saved;
}
