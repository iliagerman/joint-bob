// Activity overview: a movie where two stick-figure hosts explain what a conversation did. It is its own feature.
// It keeps its own record, reads the conversation and its changes directly, and never writes or shows the change story.
import { api, apiBlob, apiLines } from "./api.js";
import { elements } from "./elements.js";
import { playStoryPodcast } from "./git-story-podcast.js";
import { projectGitUrl } from "./project-git-url.js";
import { toast } from "./shell.js";
import { state } from "./state.js";
import { activeChatSession } from "./terminal.js";

const buttons = [elements.activityOverviewButton, elements.navOverviewButton];

// Streams the writer's progress and returns the final line, which carries the movie's script.
async function requestMovie(url, body, onStage) {
  let done = null;
  await apiLines(url, { method: "POST", body: JSON.stringify(body) }, (line) => {
    if (line.type === "error") throw Object.assign(new Error(line.error), { details: line.details });
    if (line.type === "progress") onStage(line.stage);
    if (line.type === "done") done = line;
  });
  if (!done) throw new Error("The connection closed before the Activity overview finished. If the writer completed it, it is saved; try again.");
  return done;
}

function setWriting(writing) {
  for (const button of buttons) {
    button.disabled = writing;
    button.setAttribute("aria-busy", String(writing));
  }
}

async function openActivityOverview(conversationId) {
  const target = { projectId: state.activeProjectId, nodeId: state.activeNodeId, taskId: state.activeTaskId };
  if (!target.projectId) { toast("Select a project first"); return; }
  const url = (route, params) => projectGitUrl(target, route, params);
  setWriting(true);
  let thread;
  let script;
  let settings;
  let voice;
  try {
    ({ settings } = await api("/api/story-settings"));
    toast("Preparing the Activity overview. A new one takes a minute or two.", 6000);
    ({ thread, script } = await requestMovie(url("overview"), { conversationId, settings }, () => {}));
    voice = await api(url("story-voice", { voiceProvider: settings.voiceProvider }));
  } catch (error) {
    toast(`Could not write the Activity overview. ${error.message}`, 12000);
    return;
  } finally {
    setWriting(false);
  }
  const narrates = settings.narrate && voice.available;
  // The movie is written for sound, so a silent one says why instead of playing as if nothing was wrong.
  if (settings.narrate && !voice.available) toast(`The Activity overview plays without sound. ${voice.reason}`, 14000);
  const write = (extra, onProgress) => requestMovie(url("story-podcast"), { threadId: thread.id, settings, ...extra }, onProgress).then((line) => line.script);
  playStoryPodcast({
    script, settings, host: document.body, notify: toast,
    narrate: narrates ? (text, who) => apiBlob(url("story-voice"), { method: "POST", body: JSON.stringify({ text, who, settings }) }) : null,
    ask: settings.ask ? (question, onProgress) => write({ question }, onProgress) : null,
    rewrite: (onProgress) => write({ regenerate: true }, onProgress),
  });
}

for (const button of buttons) {
  button.addEventListener("click", () => {
    const session = activeChatSession();
    if (!session) { toast("Open a conversation first"); return; }
    openActivityOverview(session.conversationId ?? session.id).catch((error) => toast(error.message));
  });
}
