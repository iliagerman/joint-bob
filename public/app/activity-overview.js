// Activity overview: a movie, drawn on paper like the landing page's films, where two hosts explain what a conversation did. It is its own feature.
// It keeps its own record, reads the conversation and its changes directly, and never writes or shows the change story.
import { api, apiBlob, apiLines } from "./api.js";
import { elements } from "./elements.js";
import { playStoryPodcast } from "./git-story-podcast.js";
import { projectGitUrl } from "./project-git-url.js";
import { toast } from "./shell.js";
import { voiceForThisNode } from "./voice-choice.js";
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

// While the open-source voice installs or updates itself, the movie waits for it instead of playing silently.
const VOICE_WAIT_MS = 180_000;
const VOICE_CHECK_MS = 2_000;

async function readyVoice(check, onStage) {
  const started = Date.now();
  let voice = await check();
  while (!voice.available && voice.local.installing && Date.now() - started < VOICE_WAIT_MS) {
    onStage(voice.local.outdated ? "Updating the open-source voice" : "Installing the open-source voice, once");
    await new Promise((resolve) => setTimeout(resolve, VOICE_CHECK_MS));
    voice = await check();
  }
  return voice;
}

// Writing a new movie takes a minute or more, so a card stays on screen with the current step and the time so far.
function showProgress() {
  const stage = Object.assign(document.createElement("span"), { className: "overview-progress-stage", textContent: "Starting" });
  const time = Object.assign(document.createElement("span"), { className: "overview-progress-time", textContent: "0:00" });
  const title = Object.assign(document.createElement("strong"), { textContent: "Activity overview" });
  const copy = Object.assign(document.createElement("span"), { className: "overview-progress-copy" });
  copy.append(title, stage);
  const card = Object.assign(document.createElement("div"), { className: "overview-progress", role: "status" });
  card.dataset.testid = "activity-overview-progress";
  card.append(Object.assign(document.createElement("span"), { className: "git-review-spinner" }), copy, time);
  document.body.append(card);
  const started = Date.now();
  const tick = setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }, 1000);
  for (const button of buttons) { button.disabled = true; button.setAttribute("aria-busy", "true"); }
  return {
    stage: (text) => { stage.textContent = text; },
    done: () => {
      clearInterval(tick);
      card.remove();
      for (const button of buttons) { button.disabled = false; button.setAttribute("aria-busy", "false"); }
    },
  };
}

// One movie at a time. Pressing Overview again for the same conversation brings the one that is already there back,
// where it left off, instead of starting it over; another conversation's movie is ended first.
let live = null;

async function openActivityOverview(conversationId, audio) {
  const target = { projectId: state.activeProjectId, nodeId: state.activeNodeId, taskId: state.activeTaskId };
  if (!target.projectId) { toast("Select a project first"); return; }
  const url = (route, params) => projectGitUrl(target, route, params);
  if (live?.conversationId === conversationId) { live.movie.show(); return; }
  const settings = await voiceForThisNode();
  if (!settings) return;
  live?.movie.end();
  const progress = showProgress();
  let thread;
  let script;
  let voice;
  try {
    ({ thread, script } = await requestMovie(url("overview"), { conversationId, settings }, progress.stage));
    progress.stage("Checking the voice");
    voice = await readyVoice(() => api(url("story-voice", { voiceProvider: settings.voiceProvider })), progress.stage);
  } catch (error) {
    toast(`Could not write the Activity overview. ${error.message}`, 12000);
    return;
  } finally {
    progress.done();
  }
  const narrates = settings.narrate && voice.available;
  // The movie is written for sound, so a silent one says why instead of playing as if nothing was wrong.
  if (settings.narrate && !voice.available) toast(`The Activity overview plays without sound. ${voice.reason}`, 14000);
  const write = (extra, onProgress) => requestMovie(url("story-podcast"), { threadId: thread.id, settings, ...extra }, onProgress).then((line) => line.script);
  const movie = playStoryPodcast({
    script, settings, host: document.body, notify: toast, audio,
    onEnd: () => { if (live?.movie === movie) live = null; },
    narrate: narrates ? (text, who) => apiBlob(url("story-voice"), { method: "POST", body: JSON.stringify({ text, who, settings }) }) : null,
    ask: settings.ask ? (question, onProgress) => write({ question }, onProgress) : null,
    // Writing it again reads the conversation again, so the movie gets a new record; questions follow it there.
    rewrite: (onProgress) => requestMovie(url("overview"), { conversationId, settings, regenerate: true }, onProgress).then((line) => { thread = line.thread; return line.script; }),
  });
  live = { conversationId, movie };
}

for (const button of buttons) {
  button.addEventListener("click", () => {
    const session = activeChatSession();
    if (!session) { toast("Open a conversation first"); return; }
    // Played inside this click, so Safari lets the same element speak once the movie is written minutes later.
    const audio = new Audio();
    audio.play().catch(() => {});
    openActivityOverview(session.conversationId ?? session.id, audio).catch((error) => toast(error.message));
  });
}
