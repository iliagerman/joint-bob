#!/bin/sh
# Generates the films' narration, music bed and sound effects with ElevenLabs into public/audio.
# Needs ELEVENLABS_API_KEY. The narrator is Liam, a stock American voice; set ELEVENLABS_VOICE to
# use another one. A file that exists is kept, so a rerun only makes what is missing; delete a
# file (or set FORCE=1) to have it made again.
set -eu
SKILL="${ELEVENLABS_SKILL:-$HOME/.claude/skills/elevenlabs/scripts}"
VOICE="${ELEVENLABS_VOICE:-TX3LPaxmHKxFdv7VOQHJ}"
OUT="$(cd "$(dirname "$0")" && pwd)/public/audio"
mkdir -p "$OUT"

missing() { [ "${FORCE:-}" = 1 ] || [ ! -s "$OUT/$1.mp3" ]; }
say() { missing "$1" || return 0; python3 "$SKILL/speech.py" "$2" -v "$VOICE" -o "$OUT/$1.mp3" --stability 0.38 --similarity 0.8 --style 0.45; }
say vo-01 "Your agent is on a roll."
say vo-02 "You close the laptop."
say vo-03 "And your agent... dies."
say vo-04 "Let's try that again. With Joint Bob."
say vo-05 "Now it runs on your server."
say vo-06 "Close the lid. It keeps going."
say vo-07 "Check in from your phone."
say vo-08 "Bring in a teammate. Same conversation, live."
say vo-09 "Or fork it, and try your own idea."
say vo-10 "Wire your alerts to an agent."
say vo-11 "Three A.M. Production breaks. The alert calls Joint Bob."
say vo-12 "An agent finds the bug, fixes it, and opens a pull request."
say vo-13 "You wake up to a fix."
say vo-14 "Then see what happened, and why."
say vo-15 "Joint Bob. Your agents keep working. You don't have to."

# The use-case films, one group each.
say lid-01 "A long task. And you have to leave."
say lid-02 "Move it to your server. Two clicks."
say lid-03 "Close the laptop. It keeps running."
say lid-04 "Watch it finish from your phone."
say lid-05 "And tell it what's next."
say lid-06 "Joint Bob. Start anywhere. Finish anywhere."

say team-01 "Start a team. Send one link."
say team-02 "Your teammate joins from her own machine."
say team-03 "Share a project. Only that project."
say team-04 "Now she's in your conversation, live."
say team-05 "Or she forks it, and tries her own idea."
say team-06 "Joint Bob. Your whole team, in the same conversation."

say schedule-01 "Some checks, nobody wants to do every hour."
say schedule-02 "So schedule an agent. Tell it what to look for."
say schedule-03 "Every hour, it reviews the support calls."
say schedule-04 "It finds what's hurting them, fixes it, and opens a pull request."
say schedule-05 "You just read the report."
say schedule-06 "Joint Bob. Set it once. It keeps watching."

say browser-01 "Give your agent a real browser."
say browser-02 "It clicks through your site, like a customer."
say browser-03 "Finds the bug. Fixes it. Checks again."
say browser-04 "You watch it live, and take the wheel any time."
say browser-05 "Joint Bob. Agents that see what they ship."

say secrets-01 "Add a credential once."
say secrets-02 "Your other machines get it."
say secrets-03 "Share it with the team. Read-only for them."
say secrets-04 "Attach it to a project, and agents just use it."
say secrets-05 "It never gets pasted into a chat."
say secrets-06 "Joint Bob. One place for your keys."

say analytics-01 "Where did the money go?"
say analytics-02 "What changed since last month, in one sentence."
say analytics-03 "And which skill keeps failing."
say analytics-04 "Joint Bob. Know what your agents cost, and why."

missing music && python3 "$SKILL/music.py" --prompt "Playful upbeat instrumental, bouncy funk pop groove with hand claps, plucky bass and bright synth stabs, light-hearted and fun, 118 bpm, no vocals" --length-ms 38000 -o "$OUT/music.mp3"
sfx() { missing "$1" || return 0; python3 "$SKILL/sfx.py" "$2" --duration "$3" -o "$OUT/$1.mp3"; }
sfx sfx-lid "Laptop lid closing shut, soft plastic click, short and dry" 1
sfx sfx-whoosh "Short clean airy whoosh, fast transition swipe" 1
sfx sfx-chime "Single soft bright notification chime, clean" 1
sfx sfx-powerdown "Computer powering down, descending electronic whine, short" 1.5
sfx sfx-flatline "Hospital heart monitor flatline, one continuous beep" 2
sfx sfx-trombone "Sad trombone, comedic fail, wah wah wah waaah" 3
sfx sfx-rewind "Fast tape rewind, squeaky whir" 1.2
sfx sfx-pop "Cartoon bubble pop, short and bright" 0.5
sfx sfx-alarm "Short urgent alert alarm, two beeps" 1
sfx sfx-party "Party popper pop with confetti" 1.5
sfx sfx-snore "Single cartoon snore, comedic" 1.5
