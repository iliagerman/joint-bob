# Joint Bob landing page films

Short films for the landing page, built from real recordings of the app, and a draft of the
page that shows them. Nothing in them comes from a real node: every screen is recorded on
throwaway nodes with invented projects.

## The films

All are 1920×1080 at 30 fps, in `out/`.

| Film | Length | What it shows |
| --- | --- | --- |
| `teaser` | 50 s | The whole story: an agent dies with the laptop; the same task in Joint Bob runs on the home server and is picked up from a phone; a teammate joins and forks; a 3 AM alert becomes a pull request; the Costs dashboard. |
| `hero` | 22 s | The teaser's first two parts, tightened, for the top of the page. |
| `lid` | 21 s | A long task planned on the laptop, moved to the home server with "Runs on" and "Take ownership", then followed and continued from a phone. |
| `team` | 24 s | A cluster made in Settings, a one-time link, the teammate joining on her machine, one project shared, then her message in the shared conversation and her fork. |
| `schedule` | 22 s | A scheduled task on a support line: every hour an agent reviews the calls, fixes what causes the bad ones and opens a pull request; the report waits in the review inbox. |
| `alerts` | 18 s | The teaser's webhook part on its own. |
| `browser` | 18 s | An agent driving the app's browser on a staging shop: it reproduces a checkout bug, fixes it, checks again; then a person takes control and hands it back. |
| `secrets` | 18 s | A GitHub account added once, arriving on the owner's other machine, shared with the team read-only, attached to a project and used by an agent there. |
| `analytics` | 15 s | The Costs dashboard: where the money went, what changed against last month, which skill fails more. |

`hero` and `alerts` are cut from the teaser (`cut` in `film/films.js`), so a change to the
teaser changes them too.

## How they are made

No video framework: plain JavaScript, Three.js, headless Chrome and ffmpeg.

1. **Capture** (`capture/`). `record.ts` seeds a scratch environment under `/tmp`, starts three
   nodes on loopback ports 8891 to 8893 (MacBook Pro, Home server, Maya's MacBook), pairs the
   first two as twins and drives real pages with real clicks and typing. Frames come from
   Chrome's screencast at full device resolution and are encoded at a constant 30 fps into
   `public/captures/`, with the time of every click in `public/captures/meta.json`. One take
   per story, each in a fresh environment: `handoff`, `webhook` and `costs` for the teaser (in
   `record.ts`), and `move`, `cluster`, `schedule`, `browser` and `secrets` for the use-case
   films (in `takes.ts`).
2. **Sound** (`audio.sh`). Narration (Liam, a stock American voice), a music bed and the
   effects, from ElevenLabs into `public/audio/`. Needs `ELEVENLABS_API_KEY`. It keeps files
   that exist, so a rerun makes only what is missing.
3. **Film** (`film/`). A plain page that draws one exact frame on request
   (`window.film.render(frame)`). The teaser is written out by hand in `timeline.js`,
   `stage.js` and `overlay.js`. Each use-case film is a description in `film/films/`: the
   devices in the room, which stretch of which recording each shows, the camera's shots, and
   the captions, stickers, rings and sounds. `feature.js` turns a description into a film.
   `films.js` lists them all.
4. **Render** (`render.ts`). Extracts the recording frames a film shows, serves the page on a
   loopback port, photographs every frame in headless Chrome on the GPU, then has ffmpeg encode
   them and mix the sound. About a minute and a half for the teaser on an M1 Max.

Every film plays at nine tenths of the pace it was written at (`PACE` in `film/films.js`), because
at full pace they felt rushed. The frame numbers in a film's description are still the written
ones. The render draws each frame for its own moment and slows each sound by the same amount with
its pitch kept, so picture, captions and voice stay together.

```bash
npm install
npm run capture                     # re-record every clip (about fifteen minutes)
./audio.sh                          # makes missing narration; it spends ElevenLabs credit
npm run render -- --film lid        # one film, to out/lid.mp4
npm run render:all                  # all nine
npm run still -- 340 --film team    # one frame, to check a change: out/team-0340.jpg
npm run landing                     # the landing page's 720p copies and stills
```

Capture and render run from the repository root, because they use its Chrome launcher and
`playwright-core`. The npm scripts take care of that. A take can also be recorded alone:
`node --import tsx promo-video/capture/record.ts --take browser` from the repository root.

## The landing page draft

`landing/index.html`, `landing.css` and `landing.js`: no build step; open `index.html` in a
browser. `npm run landing` fills `landing/media/` from `out/`.

The page wears the app's look (its tokens, dark and light, copied from `public/styles.css`; its
serif headings, mono labels, chat bubbles, tool rows and composer) but it is not laid out like
the app. It is one scroll, told as a journey into it:

1. **The way in.** The hero carries the install command with a Copy button, so nobody has to
   reach the foot of the page for it. It stays put while the scroll lifts the words away and pulls the
   22-second film up until it fills the window and darkens, like a screen being passed through.
2. **Inside.** A row of machines slides sideways as the page goes down.
3. **The journey.** One line runs down the page with a stop for each use case. At each stop
   the film glides in from one side and the words from the other, swapping sides every time,
   and the details rise from below one after another.
4. **The tour**, growing as it arrives; **three cards** from the left, below and the right;
   and **Install**: the app's composer, holding the command, rising from below.

Sound has two places. On the page the films play silent; a click on any film (or the speaker
in the bar) turns sound on, and from then on the film the mouse is moved onto is the one that is
heard, fading in and out; on a touch screen it is the film most on screen. A film that slides
under a resting mouse while the page scrolls stays silent, and so does the hero's film once it
has started to grow, since by then it is under the mouse wherever the mouse is. A browser allows
a page no sound before a click, which is why the first one is needed. The other place is the
theater: the button on a film's bar, or "Watch with sound" in the hero, opens that film large,
with its sound and controls, and plays the rest after it (`playlist` in `landing.js`).

On a narrow screen the row of seven pictures is a carousel (swipe, snap, dots under it), films and
words come in from the side over a short distance so the screen's edge never cuts them, the offer
at the foot of the window is only its play button, and a short screen drops the hero's small print.
The page clips what overflows sideways, so a scroll-width check finds nothing: to check a narrow
layout, look at where the elements are.

The page asks to be clicked in three places: a row of seven pictures near the top ("Pick one
to watch"), a pill on every film that sends out a ring until one has been watched, and a button
at the foot of the window that names the use case in view. All of them open the theater.

Films come in two sizes (`landing/media.sh`): 720p for the cards down the page, and 1080p, the
size they are rendered at, for the hero, the tour and the theater.

Besides the entrances, the scroll does a few more things: film cards swing in like doors and
keep a little depth while they are on screen, headings rise a word at a time, the stops lean
with the speed of the scroll, motes behind the page stretch into streaks at speed, a branch
is drawn from the line to each film, and the tour's screen tilts up to face the reader.

The window scrolls as it always does. Every movement follows a smoothed copy of the scroll
position (`draw` in `landing.js`), so things ease after the hand and settle. The use cases and
their texts are the `cases` list at the top of `landing.js`.

### Publishing

The page is live at https://joint-bob.bobthebot.io, in the Sela AWS account (CLI profile `sela`).

```sh
npm run landing            # only if the films changed
npm run landing:publish
```

`landing/publish.sh` deploys the CloudFormation stack `joint-bob-landing` (us-east-1) from
`landing/infra.yaml`, uploads `index.html`, `landing.css`, `landing.js` and `media/`, and clears
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
- In `secrets` and in the teaser the team's cluster is made through the API before recording.
  In `team` it is made on screen. That take runs without the twin pairing, because a twin shows
  as "Twin · error" on the cluster map when no Syncthing runs.
- "Runs on" is a native menu, which a headless page does not draw: the pointer goes to it and
  the choice appears.
- Headless frames carry no pointer, so the page draws one that follows the real mouse events.
- Two screens are drawn, not recorded, because they show the world outside the app: the bare
  terminal of the teaser's first part and the wall of production logs at 3 AM (`paintTerminal`
  and `paintLogs` in `film/stage.js`).

Every other screen is the app as it runs.
