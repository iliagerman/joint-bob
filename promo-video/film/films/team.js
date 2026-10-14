// Use case: a team. One person makes a cluster and sends a link, a teammate joins from her
// own machine, one project is shared, and she is in its conversations: writing into one,
// then forking it. The last two scenes use the teaser's recordings of the same people.
import { around, bed, defineFeature, display, look, sfx, spoken } from "../feature.js";
import { easeInOut, panelPoint } from "../timeline.js";

const scene = { create: 0, join: 90, share: 174, arrives: 270, together: 330, fork: 432, end: 528 };
const duration = 650;
// The teammate's message is sent this many frames into the film; both screens keep that one clock.
const sends = scene.together + 42;

const mine = display([3.9, 2.05, -1.5], { width: 4.8, height: 3.0, turn: 0.12 });
const hers = display([9.1, 2.05, -1.5], { width: 4.8, height: 3.0, turn: -0.12, arrive: scene.join - 8 });
const both = { position: [6.5, 2.35, 11.0], target: [6.5, 1.95, -1.5] };

const lines = [
  { audio: "audio/team-01.mp3", at: 6, until: scene.join - 3, text: "Start a team. *Send one link.* 🔗" },
  { audio: "audio/team-02.mp3", at: scene.join + 6, until: scene.share - 3, text: "Your teammate joins *from her own machine.*" },
  { audio: "audio/team-03.mp3", at: scene.share + 6, until: scene.arrives + 28, text: "Share a project. *Only that project.*" },
  { audio: "audio/team-04.mp3", at: scene.together + 6, until: scene.fork - 3, text: "Now she's *in your conversation,* live. 👋" },
  { audio: "audio/team-05.mp3", at: scene.fork + 6, until: scene.end - 3, text: "Or she *forks it* and tries her own idea. 🍴" },
  { audio: "audio/team-06.mp3", at: scene.end + 4, until: 0, text: "" },
];

export default defineFeature({
  id: "team",
  kicker: "Teams",
  duration,
  end: scene.end,
  tagline: ["Your whole team,", "in the same conversation."],
  devices: { mine, hers },
  screens: (meta) => {
    const owner = meta.clusterOwner.events;
    const mate = meta.clusterMate.events;
    const server = meta.server.events;
    const teammate = meta.teammate.events;
    const sinceSend = (frame) => (frame - sends) / 30;
    return {
      mine: [
        // The name typed and the cluster made, then the one-time link.
        { clip: "clusterOwner", from: 0, to: 46, start: owner.created - 1.95, rate: 1.25 },
        { clip: "clusterOwner", from: 46, to: scene.share, start: owner.invited - 0.9, rate: 1 },
        // "I share": one project ticked, saved, confirmed.
        { clip: "clusterOwner", from: scene.share, to: scene.share + 42, start: owner.chosen - 1.1, rate: 1 },
        { clip: "clusterOwner", from: scene.share + 42, to: scene.together - 8, start: owner.shared - 1.3, rate: 1.3 },
        // Her message arrives in the conversation; the close look starts once the agent is answering.
        { clip: "server", from: scene.together - 8, to: scene.together + 55, start: server.teammateSend + sinceSend(scene.together - 8), rate: 1 },
        { clip: "server", from: scene.together + 55, to: scene.end - 10, start: server.teammateSend + 1.15, rate: 1 },
        { clip: "server", from: scene.end - 10, to: duration, start: server.teammateAnswered + 0.5, rate: 0 },
      ],
      hers: [
        // Settings, Cluster, Join, the pasted link, and the cluster on her map.
        { clip: "clusterMate", from: scene.join - 10, to: scene.join + 26, start: mate.pasted - 1.25, rate: 1 },
        { clip: "clusterMate", from: scene.join + 26, to: scene.arrives - 8, start: mate.pasted - 0.1, rate: 1 },
        // The project, with the team's name on it, in her own list.
        { clip: "clusterMate", from: scene.arrives - 8, to: scene.together, start: mate.received - 0.9, rate: 1 },
        // The same conversation, then the fork: its menu, its new name, her question in it.
        { clip: "teammate", from: scene.together, to: scene.fork, start: teammate.teammateSend + sinceSend(scene.together), rate: 1 },
        { clip: "teammate", from: scene.fork, to: scene.fork + 30, start: teammate.forkClick - 0.8, rate: 1 },
        { clip: "teammate", from: scene.fork + 30, to: scene.fork + 57, start: teammate.forked + 2.0, rate: 1 },
        { clip: "teammate", from: scene.fork + 57, to: scene.end - 10, start: teammate.forkSend + 0.9, rate: 1 },
        { clip: "teammate", from: scene.end - 10, to: duration, start: teammate.forkAnswered + 0.5, rate: 0 },
      ],
    };
  },
  shots: [
    { from: 0, to: 46, start: look(mine, 0.52, 0.36, 5.4, 0.2), end: look(mine, 0.52, 0.36, 4.6, 0.1) },
    { from: 46, to: scene.join, start: look(mine, 0.5, 0.5, 5.9, 0.15), end: look(mine, 0.5, 0.52, 5.3, 0.05) },
    { from: scene.join, to: scene.join + 20, start: look(mine, 0.5, 0.52, 5.3, 0.05), end: both, ease: easeInOut },
    { from: scene.join + 20, to: scene.share, start: look(hers, 0.5, 0.34, 5.6, -0.2), end: look(hers, 0.5, 0.34, 4.7, -0.1) },
    { from: scene.share, to: scene.arrives, start: look(mine, 0.44, 0.44, 4.7, 0.1), end: look(mine, 0.4, 0.42, 3.9, 0.05) },
    { from: scene.arrives, to: scene.together, start: look(hers, 0.26, 0.42, 4.8, -0.1), end: look(hers, 0.22, 0.4, 3.9, -0.05) },
    { from: scene.together, to: scene.together + 20, start: look(hers, 0.22, 0.4, 3.9, -0.05), end: both, ease: easeInOut },
    { from: scene.together + 20, to: scene.together + 55, start: both, end: { position: [6.5, 2.3, 10.2], target: [6.5, 1.95, -1.5] } },
    { from: scene.together + 55, to: scene.fork, start: look(mine, 0.68, 0.58, 5.6, 0.2), end: look(mine, 0.7, 0.6, 4.8, 0.1) },
    { from: scene.fork, to: scene.fork + 30, start: look(hers, 0.6, 0.44, 5.6, -0.2), end: look(hers, 0.6, 0.42, 4.9, -0.1) },
    { from: scene.fork + 30, to: scene.fork + 57, start: look(hers, 0.56, 0.2, 5.0, -0.1), end: look(hers, 0.54, 0.16, 4.3, -0.05) },
    { from: scene.fork + 57, to: scene.end, start: look(hers, 0.68, 0.6, 5.5, -0.15), end: look(hers, 0.7, 0.62, 5.0, -0.05) },
    { from: scene.end, to: duration, start: { position: [6.3, 3.4, 13], target: [6.5, 1.8, -1.5] }, end: { position: [6.5, 3.6, 14.5], target: [6.5, 1.8, -1.5] } },
  ],
  links: [
    { from: [mine.center.x + 1.6, mine.center.y + 1.55, mine.center.z + 0.1], via: [6.5, 4.6, -1.2], to: [hers.center.x - 1.6, hers.center.y + 1.55, hers.center.z + 0.1], drawFrom: scene.join + 66, drawTo: scene.join + 84 },
  ],
  rings: [
    { from: scene.share + 30, to: scene.share + 42, ...around(mine, 0.228, 0.499, 0.335, 0.531), sun: true },
    { from: scene.arrives + 6, to: scene.together - 4, ...around(hers, 0.004, 0.305, 0.216, 0.45) },
  ],
  stickers: [
    { text: "① Name your team", paint: "mint", from: 10, to: 44, at: { x: 1500, y: 250 }, tilt: 3, size: 46 },
    { text: "② One link, one use 🔗", paint: "sun", from: 56, to: scene.join - 3, at: { x: 1460, y: 300 }, tilt: -3, size: 46 },
    { text: "👩‍💻 Maya's machine", paint: "ink", from: scene.join + 24, to: scene.join + 64, at: { x: 1480, y: 240 }, tilt: 3, size: 44 },
    { text: "She's in ✅", paint: "mint", from: scene.join + 68, to: scene.share - 3, at: { x: 1460, y: 250 }, tilt: -3, size: 50 },
    { text: "Only this project 👆", paint: "sun", from: scene.share + 26, to: scene.share + 42, at: { x: 1380, y: 300 }, tilt: 3, size: 46 },
    { text: "Shared with the team ✅", paint: "mint", from: scene.share + 74, to: scene.arrives - 3, at: { x: 1400, y: 300 }, tilt: -3, size: 46 },
    { text: "It's on her machine 👋", paint: "mint", from: scene.arrives + 8, to: scene.together - 4, at: { x: 1350, y: 330 }, tilt: 3, size: 48 },
    { text: "🧑‍💻 Alex", paint: "ink", from: scene.together + 20, to: scene.together + 53, at: panelPoint(mine, 0.2, -0.08), tilt: -3, size: 44 },
    { text: "👩‍💻 Maya", paint: "mint", from: scene.together + 24, to: scene.together + 53, at: panelPoint(hers, 0.2, -0.08), tilt: 3, size: 44 },
    { text: "Maya is in your conversation 👋", paint: "mint", from: scene.together + 58, to: scene.fork - 3, at: { x: 1390, y: 190 }, tilt: 3, size: 46 },
    { text: "🍴 A fork: her own copy", paint: "sun", from: scene.fork + 33, to: scene.end - 3, at: { x: 1380, y: 330 }, tilt: -3, size: 50 },
    { text: "Yours stays as it was ✅", paint: "mint", from: scene.fork + 60, to: scene.end - 3, at: { x: 1420, y: 440 }, tilt: 3, size: 42 },
  ],
  lines,
  sounds: [bed(duration, 4), ...spoken(lines), sfx("pop", 10), sfx("pop", 56), sfx("whoosh", scene.join - 3), sfx("chime", scene.join + 66), sfx("whoosh", scene.share - 3), sfx("pop", scene.share + 26), sfx("chime", scene.share + 72), sfx("whoosh", scene.arrives - 3), sfx("pop", scene.arrives + 8), sfx("whoosh", scene.together - 3), sfx("chime", scene.together + 56), sfx("whoosh", scene.fork - 3), sfx("pop", scene.fork + 33), sfx("pop", scene.fork + 60), sfx("whoosh", scene.end - 3)],
});
