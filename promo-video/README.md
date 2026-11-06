# Joint Bob landing page films

Short films for the landing page, built from real recordings of the app, and a draft of the
page that shows them. Nothing in them comes from a real node: every screen is recorded on
throwaway nodes with invented projects.

## The films

All are 30 fps, in `out/`: the two drawn films (`monday`, `short`) at 3840×2160,
the feature films at 1920×1080.

| Film | Length | What it shows |
| --- | --- | --- |
| `monday` | 1:41 | The main film, drawn on paper and shown at the top of the page: one developer's day, with Alex, his desk, the café, Maya's desk, his home and the train drawn by a pencil as the camera travels over the sheet, and the real recordings playing in the screens drawn there. A test migration starts on his laptop, one Claude account runs out and the next in his pool takes over, Guardian pauses a risky delete, a dashboard is asked for, at lunch his assistant says how the fix is going and he schedules the launch for six from his phone, a teammate writes into his conversation and forks it, two hosts explain the change, the work moves to his server, the laptop closes, he merges from his phone on the train, and at six the launch goes out. |
| `short` | 0:30 | The 30-second version for social media (LinkedIn), not on the page: its own five lines on the same sheet, at his desk and on the train only. The release due at six, the pool taking over, Guardian asking first and the launch scheduled, the work moved to his server and merged from the train, and the launch going out. |
| `lid` | 49 s | A long task planned on the laptop, moved to the home server with "Runs on" and "Take ownership", then followed and continued from a phone. |
| `team` | 52 s | A cluster made in Settings, a one-time link, the teammate joining on her machine, one project shared, then her message in the shared conversation and her fork. |
| `pools` | 51 s | Three Claude accounts added as profiles in Settings → Connections, one pool with them in failover order, the pool as the default, and the pool's own failover test running account 1 and then account 2 out of quota while account 3 takes over. |
| `budgets` | 48 s | Cost control: a team limit in Settings → Cluster → Budget, a tighter daily limit on a project and a total on one conversation, the amber warning at 80% and the red notice that holds new work. |
| `guardian` | 53 s | A rule as a plain question, the switch for every conversation, an agent's `rm -rf` paused for Block or Allow once, the agent archiving instead, and a cloud key taken out of a message. |
| `story` | 1:03 | The written story of a change, then Overview: two hosts explain it in the Kokoro voices the app uses, and a question becomes a new chapter. |
| `dashboards` | 41 s | A dashboard described in a sentence, built by the dashboard agent, checked, saved and refreshed with no AI. |
| `assistant` | 1:00 | A conversation made a release assistant and told what to look after; it answers how a feature is going from the project's conversations, books a review with Maya, and from the phone a launch is scheduled for every Monday at six; at six the launch runs through the assistant and reports in the same chat. |
| `schedule` | 49 s | A scheduled task on a support line: every hour an agent reviews the calls, fixes what causes the bad ones and opens a pull request; the report waits in the review inbox. |
| `alerts` | 40 s | A webhook on the home server: a 3 AM alert starts a conversation that fixes the bug and opens a pull request; the report waits in the morning inbox. |
| `phone` | 38 s | Joint Bob installed on a phone, every conversation there, one picked up where it was and the next step sent from the phone. |
| `browser` | 41 s | An agent driving the app's browser on a staging shop: it reproduces a checkout bug, fixes it, checks again; then a person takes control and hands it back. |
| `secrets` | 44 s | A GitHub account added once, arriving on the owner's other machine, shared with the team read-only, attached to a project and used by an agent there. |
| `analytics` | 33 s | The Costs dashboard: where the money went, what changed against last month, which skill fails more. |

`short` is a film of its own (`film/films/short.js`) on the same sheet as `monday`: both draw the
places in `film/sketch/places.js`, so a change to a place changes both. The old 50-second teaser (`timeline.js`, `stage.js`, `overlay.js`) is no longer in the list; its
staging, stage and overlay code is what `feature.js` builds on.

## How they are made

No video framework: plain JavaScript, Three.js, headless Chrome and ffmpeg.

1. **Capture** (`capture/`). `record.ts` seeds a scratch environment under `/tmp`, starts three
   nodes on loopback ports 8891 to 8893 (MacBook Pro, Home server, Maya's MacBook), pairs the
   first two as twins and drives real pages with real clicks and typing. Frames come from
   Chrome's screencast at full device resolution and are encoded at a constant 30 fps into
   `public/captures/`, with the time of every click in `public/captures/meta.json`. One take
   per story, each in a fresh environment: `handoff`, `webhook` and `costs` (in `record.ts`),
   `move`, `cluster`, `schedule`, `browser` and `secrets` (in `takes.ts`), and `pools`,
   `budgets`, `guardian`, `dashboards`, `assistant`, `phone` and `story` (in
   `feature-takes.ts`).
2. **Sound.** The narration is the open-source Kokoro voice (`af_bella`, speed 1.05) that Joint
   Bob installs for story narration: `narrate.ts` speaks every line in `narration.json` into
   `public/audio/`, with no paid service, and writes each line's length to `film/voice-lengths.js`. It needs the voice installed on this machine (Settings → Activity
   overview), and keeps files that exist unless `--force`. The story film's two hosts are spoken
   by the `story` take itself, in the voices the app's Activity overview uses. The feature films'
   music bed and sound effects come from `audio.sh` (ElevenLabs); they exist, so it has nothing to
   make. The drawn films have scores of their own, made in code by `score.mjs` (felt piano, string
   pad, bass and bells, with no service): each is as long as its film and lands on C, with bells,
   at the second the merge goes through (`node promo-video/score.mjs --length 98.10 --peak 85.4
   --out promo-video/public/audio/score-monday.mp3`; `score()` in `feature.js` starts it late by
   the offset the script prints). There is no whoosh between scenes any more: it was a low thump
   that sounded like a door shutting.
3. **Film** (`film/`). A plain page that draws one exact frame on request
   (`window.film.render(frame)`). The teaser is written out by hand in `timeline.js`,
   `stage.js` and `overlay.js`. Each use-case film is a description in `film/films/`: the
   devices in the room, which stretch of which recording each shows, the camera's shots, and
   the captions, stickers, rings and sounds. `feature.js` turns a description into a film.
   `films.js` lists them all. The drawn films are built differently, with the drawing kit in the
   app's `public/app/sketch/`, which the app's Activity overview draws with too: `ink.js` is a pen
   that lays down wobbly ink lines, watercolour washes and handwriting (Caveat, `caveat.ttf`, OFL)
   on a 2D canvas over a paper texture, revealing each group of them over a stretch of frames, ink
   first in the order the lines are made, then colour, with a pencil at the tip; `camera.js` the
   camera's views and glides; `people.js` is Alex, Maya and Jonah, posed by where their hands go;
   `things.js` the furniture and devices. The films' own parts are in `film/sketch/`: `places.js`
   the sheet of the day (desk, café, Maya's desk, home, train, and the pencil line through them)
   and `story.js` the shots over the sheet and into the drawn screens, the sticky notes, the marker
   rings, the subtitles and the end card. `render.ts` serves the kit to the page at
   `/public/app/sketch/`, the path the films' imports lead to.
4. **Render** (`render.ts`). Extracts the recording frames a film shows, serves the page on a
   loopback port, photographs every frame in headless Chrome on the GPU, then has ffmpeg encode
   them and mix the sound. `--scale 2` photographs at 3840×2160 (the drawn films: about thirteen
   minutes for `monday` on an M1 Max). `--remix` mixes the sound again into a film already in
   `out/`, keeping its picture, for a change that only touches sound.

Each film is timed by its narration. `beats` in `film/feature.js` lays the lines end to end from
their lengths, so every sentence is heard whole and the picture follows it; `fit` plays a stretch
of a recording across a beat, and `frameOf` places a ring or a note at the moment its part of the
screen appears. Nothing is slowed after the fact. Two things keep the films smooth: the camera
glides from one shot into the next, and a jump within or between recordings dissolves over half a
second. Captions read as
subtitles, each word brightening as it is spoken.

```bash
npm install
npm run capture                     # re-record every clip (about fifteen minutes)
node --import tsx promo-video/narrate.ts   # missing narration, with Kokoro (from the repository root)
npm run render -- --film lid        # one film, to out/lid.mp4
npm run render:all                  # all sixteen (the drawn two at --scale 2)
npm run still -- 340 --film team    # one frame, to check a change: out/team-0340.jpg
npm run landing                     # the landing page's 720p copies and stills
```

Capture and render run from the repository root, because they use its Chrome launcher and
`playwright-core`. The npm scripts take care of that. A take can also be recorded alone:
`node --import tsx promo-video/capture/record.ts --take browser` from the repository root.

## The landing page draft

`landing/index.html`, `landing.css`, `features.js`, `fleet.js` and `landing.js`: no build step; open
`index.html` in a browser. `npm run landing` fills `landing/media/` from `out/`.

`features.js` holds everything the page says about each feature: what it is, how to use it with the
labels as they are in the app, what is good to know, and where to find it. A feature with a film
is told in the fleet, in the brief beside its film; the rest are explained in words under "More to know", followed by a
list of smaller features.

The page wears the app's look (its tokens, dark and light, copied from `public/styles.css`; its
serif headings, mono labels, chat bubbles, tool rows and composer) but it is not laid out like
the app. It is one scroll, told as a journey into it:

1. **The way in.** The hero carries the install command with a Copy button, so nobody has to
   reach the foot of the page for it, and a switch between macOS · Linux and Windows (preset
   from the browser's system). Windows gets the PowerShell installer
   (`scripts/install-windows.ps1`), which sets up WSL 2 and Ubuntu and runs the same installer
   there. The hero stays put while the scroll lifts the words away and pulls the main film
   (`monday`) up until it fills the window and darkens, like a screen being passed through.
2. **Inside.** A row of machines slides sideways as the page goes down.
3. **The fleet** (`fleet.js`): every feature film, flying by itself, each with its brief beside it as
   one centred pair, in three tabs: what it does (with the three things that happened and where to
   find it), how to use it, and what is good to know. A brief shows only near the dock, so it
   arrives and leaves with its film. On a narrow screen the brief sits under the film.
4. **More to know**: the features explained in words, and the smaller ones.
5. **Three cards** from the left, below and the right, and **Install**: the app's composer,
   holding the command and the same system switch, rising from below.

Sound has two places. On the page the films play silent; a click on any film (or the speaker
in the bar) turns sound on, and from then on the film the mouse is moved onto is the one that is
heard, fading in and out; on a touch screen it is the film most on screen. A film that slides
under a resting mouse while the page scrolls stays silent, and so does the hero's film once it
has started to grow, since by then it is under the mouse wherever the mouse is. A browser allows
a page no sound before a click, which is why the first one is needed. The other place is the
theater: the button on a film's bar, or "Watch with sound" in the hero, opens that film large,
with its sound and controls, and plays the rest after it (`playlist` in `landing.js`).

The feature films near the top are a fleet in space (`fleet.js`), in a section one window tall that
the page's scroll passes like any other. The fleet flies by itself, round and round: each film comes
in from deep space, docks in the middle for nine seconds (its film playing, silent, under targeting
corners; the brief beside it, as tall as the film) and flies past the camera as the next comes in.
The docked film's dot fills up while it waits. It holds while the mouse is on the docked film or
its brief, while a film is open in the theater, while the section is mostly off screen, and when
paused with the button by the counter; any choice the reader makes starts the wait again. The
arrows, the dots, the arrow keys and Tab pick another film, and so does a sideways swipe on a touch
screen; the mouse wheel only scrolls the page. The speed of a flight banks the ships, fires their
engine trails and stretches the stars into warp lines. With reduced motion it starts paused and
jumps between films. Space stays dark in the light theme. On a narrow screen the fleet flies
upright, with the brief under the film.

On a narrow screen films and
words come in from the side over a short distance so the screen's edge never cuts them, the offer
at the foot of the window is only its play button, and a short screen drops the hero's small print.
The page clips what overflows sideways, so a scroll-width check finds nothing: to check a narrow
layout, look at where the elements are.

The page asks to be clicked in three places: the fleet near the top ("Pick a feature
to watch") and the hero's film, which open the theater, and an Install now button at the foot of
the window, shown once the hero has gone by and until the install section is on screen (on a
narrow screen not while the fleet is, where it would cover the fleet's buttons).

Films come in two sizes (`landing/media.sh`): 720p for the fleet, and 1080p for the
hero and the theater, scaled down from the drawn films' 3840×2160. The drawn ones are
encoded tuned for animation, which keeps them at less than half the size the paper grain would
otherwise cost. `media.sh monday pools` makes only the films named. `short` gets no page copy;
the file to post is `out/short.mp4`.

Besides the entrances and the fleet, the scroll does a few more things: headings rise a word
at a time, and motes behind the page stretch into streaks at speed.

A phone has little time per frame, so the page keeps its per-frame work small: the fleet writes
only the styles that changed, straight onto the element that moves (no CSS variable changing on the
section or a ship, which would make the browser work out everything inside again); nothing carries
a permanent `will-change`; on a phone both star canvases draw at one pixel per point, the fleet's
stars hold still while the fleet does, the top film loads its 720p copy, it darkens through a black
layer rather than a filter, and the top bar has no blur behind it. On a touch screen the smoothed
scroll keeps closer to the finger.

The window scrolls as it always does. Every movement follows a smoothed copy of the scroll
position (`draw` in `landing.js`), so things ease after the hand and settle. The features and
their texts are in `features.js`.

### Publishing

The page is live at https://joint-bob.bobthebot.io, in the Sela AWS account (CLI profile `sela`).

```sh
npm run landing            # only if the films changed
npm run landing:publish
```

`landing/publish.sh` deploys the CloudFormation stack `joint-bob-landing` (us-east-1) from
`landing/infra.yaml`, uploads `index.html`, `landing.css`, `features.js`, `fleet.js`, `landing.js` and `media/`, and clears
CloudFront's copies. The stack owns a private bucket (`joint-bob-landing-138182066483`), a CloudFront
distribution and the `joint-bob` A and AAAA records. It reuses the `bobthebot.io` hosted zone and the
`*.bobthebot.io` certificate, which belong to the account and are not part of the stack.

To take it down: empty the bucket, then delete the stack.

## What is staged

- The agent's answers are scripted. `capture/fake-claude.mjs` stands in for the Claude CLI and
  replays `capture/scenarios.mjs`, so the real interface streams text and tool calls without an
  account or real work. Two scenarios also do something real: in `browser` the stand-in drives
  the app's browser through the same command line a real agent uses, and in `secrets` it lists
  the secret accounts the same way. The shell commands it reports (tests, `gh pr create`) are
  not run.
- The shop in `browser` is a three-page site served by the capture (`capture/shop.ts`), with
  one bug that the agent's "fix" switches off.
- Three things the scratch environment puts on screen are hidden with one style rule in
  `capture/browser.ts`: temp folder paths, the "Unavailable" sync state (no Syncthing runs
  there), and the "API price unavailable" label on conversations the stand-in ran.
- The dashboard's numbers come from about ten weeks of invented work that `capture/seed.ts`
  writes as transcripts, with token counts the app prices itself.
- The webhook is made through the real form. The form has no agent picker for a project
  webhook, so the node's first agent would take the call; in the scratch environment only the
  stand-in can run, and the capture points the webhook at it through the API.
- The scheduled task is made through the real dialog. Its run is started through the API, by
  the command behind "Run now", in place of waiting for the top of the hour.
- In `secrets` and in the `handoff` take the team's cluster is made through the API before recording.
  In `team` it is made on screen. That take runs without the twin pairing, because a twin shows
  as "Twin · error" on the cluster map when no Syncthing runs.
- "Runs on" is a native menu, which a headless page does not draw: the pointer goes to it and
  the choice appears.
- Headless frames carry no pointer, so the page draws one that follows the real mouse events.
- Guardian's decision model is a stub (`startDecisionModel` in `capture/feature-takes.ts`) that
  answers "yes" for `rm -rf`, `AKIA`, `ghp_` and `sk_live_` content; everything else about the
  review, the card and the removal is the app's own.
- The story and its podcast are fixtures (`capture/story-fixture.ts`) handed to the real Story view
  and Overview player through their own routes, in place of a writer model. The hosts' voices are
  Kokoro, spoken by the take.
- The dashboard agent is a stand-in (`capture/dashboard-agent.mjs`) that writes the dashboard, its
  refresh script and its manifest the way the real agent does, through `JOINT_BOB_DASHBOARD_AGENT`.
- The product screenshots saved to the assistant are drawn by the take, since there is no real shop.
- The subscription failover is the pool's own failover test ("Test failover"), not a real quota
  running out. The three Claude accounts are profiles that are never signed in.
- The assistant routes each message with a decision model (TypeSafe's System One). In the take
  a stand-in (`capture/decisions.ts`) answers it: a question about progress is recalled from
  history, a meeting or a launch is a new topic. The agent's answers, including the booked
  meeting and the launch report, are scripted like every other; no calendar is connected.
- The launch is a real scheduled task made through the assistant's Scheduled task dialog on the
  phone. Its run is started through the API in place of waiting for Monday at six.
- Budgets read each project's real recorded spend and set limits just under it, so the warning and
  the limit show without spending anything.

Every other screen is the app as it runs.
