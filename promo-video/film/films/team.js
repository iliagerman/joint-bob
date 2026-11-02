// Feature: teams, explained step by step. A cluster is made in Settings with a one-time link; a
// teammate joins from her own machine; one project is shared; she writes into a conversation and
// is answered there; then she forks it.
import { around, beats, bed, defineFeature, display, events, fit, frameOf, look, say, sfx, spoken } from "../feature.js";
import { easeInOut, panelPoint } from "../timeline.js";

const [create, join, share, together, fork, tagline] = beats(["team-01", "team-02", "team-03", { name: "team-04", hold: 20 }, "team-05", { name: "team-06", min: 116 }]);
const end = tagline.from;
const duration = tagline.to;

const mine = display([3.9, 2.05, -1.5], { width: 4.8, height: 3.0, turn: 0.12 });
const hers = display([9.1, 2.05, -1.5], { width: 4.8, height: 3.0, turn: -0.12, arrive: join.from - 8 });
const both = { position: [6.5, 2.35, 11.0], target: [6.5, 1.95, -1.5] };

const lines = [
  say(create, "Joint Bob works for teams too. To start one, you *create a cluster* in Settings, and generate *an invite link* that works once and expires after fifteen minutes."),
  say(join, "Your teammate pastes the link *on her own machine,* and joins the cluster."),
  say(share, "Joining doesn't share anything by itself. You choose *exactly which projects* your team can see, and nothing else leaves your machine."),
  say(together, "Once a project is shared, your teammate *sees its conversations live,* and can write into them. Her message is answered right there, in the same conversation."),
  say(fork, "Or she can *fork a conversation* to try an idea of her own, while yours stays exactly as it was."),
  { audio: tagline.audio, at: end + 6, until: 0, text: "" },
];

const owner = events("clusterOwner");
const mate = events("clusterMate");
const server = events("server");
const teammate = events("teammate");
// Alex's screen shows his conversation at the same moment Maya's shows hers.
const sameMoment = server.teammateSend - teammate.teammateSend;
const middle = Math.round((share.from + share.to) / 2);
// Her screen in the shared conversation, and the moment the agent's answer to her arrives.
const hersTogether = fit("teammate", together.from, fork.from, teammate.teammateRead, teammate.teammateAnswered + 2.0);
const answered = frameOf(hersTogether, teammate.teammateAnswered + 0.2);

export default defineFeature({
  id: "team",
  kicker: "Teams",
  duration,
  end,
  tagline: ["Your whole team,", "in the same conversation."],
  devices: { mine, hers },
  screens: () => ({
    mine: [
      // The name typed and the cluster made, then the one-time link.
      fit("clusterOwner", create.from, create.to, owner.created - 2.4, owner.invited + 2.4),
      { clip: "clusterOwner", from: create.to, to: share.from, start: owner.invited + 2.4, rate: 0.2 },
      // "I share": one project ticked, saved, confirmed.
      fit("clusterOwner", share.from, middle, owner.chosen - 1.6, owner.shared + 0.6),
      { clip: "clusterOwner", from: middle, to: together.from, start: owner.shared + 0.6, rate: 0.3 },
      // His conversation, as her message arrives in it and is answered.
      fit("server", together.from, fork.from, teammate.teammateRead + sameMoment, teammate.teammateAnswered + 2.0 + sameMoment),
      fit("server", fork.from, end, teammate.forkClick + sameMoment, teammate.forkAnswered + 1.0 + sameMoment),
    ],
    hers: [
      // Settings, Cluster, Join, the pasted link, and the cluster on her map.
      fit("clusterMate", join.from - 10, join.to, mate.pasted - 1.4, mate.joined + 2.2),
      // The project, with the team's name on it, in her own list.
      fit("clusterMate", middle, together.from, mate.received - 1.0, mate.listed + 0.8),
      // The same conversation, her message, and its answer; then the fork and its own answer.
      hersTogether,
      fit("teammate", fork.from, end, teammate.forkClick - 0.8, teammate.forkAnswered + 1.4),
    ],
  }),
  shots: [
    { from: create.from, to: create.to, start: look(mine, 0.52, 0.42, 5.8, 0.2), end: look(mine, 0.5, 0.5, 4.8, 0.05) },
    { from: join.from, to: join.from + 24, start: look(mine, 0.5, 0.52, 5.3, 0.05), end: both, ease: easeInOut, glide: 0 },
    { from: join.from + 24, to: join.to, start: look(hers, 0.5, 0.34, 5.6, -0.2), end: look(hers, 0.5, 0.34, 4.7, -0.1) },
    { from: share.from, to: middle, start: look(mine, 0.44, 0.44, 4.7, 0.1), end: look(mine, 0.4, 0.42, 3.9, 0.05) },
    { from: middle, to: together.from, start: look(hers, 0.26, 0.42, 4.8, -0.1), end: look(hers, 0.22, 0.4, 3.9, -0.05) },
    { from: together.from, to: together.from + 24, start: look(hers, 0.22, 0.4, 3.9, -0.05), end: both, ease: easeInOut, glide: 0 },
    { from: together.from + 24, to: together.at + 120, start: both, end: { position: [6.5, 2.3, 10.2], target: [6.5, 1.95, -1.5] } },
    { from: together.at + 120, to: fork.from, start: look(hers, 0.6, 0.6, 5.2, -0.1), end: look(hers, 0.62, 0.62, 4.6, -0.05) },
    { from: fork.from, to: end, start: look(hers, 0.6, 0.44, 5.4, -0.2), end: look(hers, 0.66, 0.56, 4.8, -0.05) },
    { from: end, to: duration, start: { position: [6.3, 3.4, 13], target: [6.5, 1.8, -1.5] }, end: { position: [6.5, 3.6, 14.5], target: [6.5, 1.8, -1.5] } },
  ],
  links: [
    { from: [mine.center.x + 1.6, mine.center.y + 1.55, mine.center.z + 0.1], via: [6.5, 4.6, -1.2], to: [hers.center.x - 1.6, hers.center.y + 1.55, hers.center.z + 0.1], drawFrom: join.at + 90, drawTo: join.at + 108 },
  ],
  rings: [
    { from: share.at + 40, to: middle - 4, ...around(mine, 0.228, 0.499, 0.335, 0.531), sun: true },
    { from: middle + 20, to: together.from - 4, ...around(hers, 0.004, 0.305, 0.216, 0.45) },
  ],
  stickers: [
    { text: "① Name your team", paint: "mint", from: create.at + 10, to: create.at + 120, at: { x: 1500, y: 250 }, tilt: 3, size: 42 },
    { text: "② One link, one use 🔗", paint: "sun", from: create.at + 130, to: create.to - 4, at: { x: 1460, y: 300 }, tilt: -3, size: 42 },
    { text: "Maya's machine 👩‍💻", paint: "ink", from: join.from + 26, to: join.at + 88, at: { x: 1480, y: 240 }, tilt: 3, size: 42 },
    { text: "She's in ✅", paint: "mint", from: join.at + 92, to: join.to - 4, at: { x: 1460, y: 250 }, tilt: -3, size: 46 },
    { text: "Only this project 👆", paint: "sun", from: share.at + 40, to: middle - 4, at: { x: 1380, y: 300 }, tilt: 3, size: 44 },
    { text: "It's on her machine 👋", paint: "mint", from: middle + 22, to: together.from - 4, at: { x: 1350, y: 330 }, tilt: 3, size: 44 },
    { text: "🧑‍💻 Alex", paint: "ink", from: together.from + 24, to: together.at + 118, at: panelPoint(mine, 0.2, -0.08), tilt: -3, size: 40 },
    { text: "👩‍💻 Maya", paint: "mint", from: together.from + 28, to: together.at + 118, at: panelPoint(hers, 0.2, -0.08), tilt: 3, size: 40 },
    { text: "Answered in the same conversation ✅", paint: "mint", from: answered, to: fork.from - 4, at: { x: 1360, y: 200 }, tilt: 3, size: 40 },
    { text: "A fork: her own copy 🍴", paint: "sun", from: fork.at + 30, to: end - 4, at: { x: 1380, y: 330 }, tilt: -3, size: 44 },
    { text: "Yours stays as it was ✅", paint: "mint", from: fork.at + 80, to: end - 4, at: { x: 1420, y: 440 }, tilt: 3, size: 40 },
  ],
  lines,
  sounds: [bed(duration, 4), ...spoken(lines), sfx("pop", create.at + 10), sfx("pop", create.at + 130), sfx("chime", join.at + 92), sfx("pop", share.at + 40), sfx("chime", middle + 22), sfx("chime", answered), sfx("pop", fork.at + 30)],
});
