import { z } from "zod";
import { save, settingsDatabase, value } from "./settings-store.js";

const SETTINGS_KEY = "storyMode";

/** Where a podcast chapter can take place. The player draws each one; the writer picks one per chapter. */
export const STORY_LOCATIONS = ["podcast", "classroom", "lecture", "coffeehouse", "street", "train", "server", "matrix", "rooftop"] as const;
export type StoryLocation = typeof STORY_LOCATIONS[number];
export const STORY_LOCATION_LABELS: Record<StoryLocation, string> = {
  podcast: "Podcast studio", classroom: "Classroom", lecture: "Lecture hall", coffeehouse: "Coffee house", street: "Street walk",
  train: "Train ride", server: "Server room", matrix: "The matrix", rooftop: "Rooftop at dawn",
};
export const STORY_MOODS =["calm", "tension", "insight", "resolved"] as const;
export type StoryMood = typeof STORY_MOODS[number];

/** The Kokoro-82M voices the narration can use. */
export const KOKORO_VOICES = [
  "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
] as const;

/** "af_heart" reads as "Heart · American, female". */
export function voiceLabel(id: string): string {
  const [prefix, name] = id.split("_");
  return `${name[0].toUpperCase()}${name.slice(1)} · ${prefix[0] === "a" ? "American" : "British"}, ${prefix[1] === "f" ? "female" : "male"}`;
}

export const VOICE_PROVIDER_CHOICES = ["auto", "kokoro", "elevenlabs"] as const;
const ELEVEN_VOICE_ID = /^[A-Za-z0-9]{16,32}$/;

export const DEFAULT_STORY_INSTRUCTIONS = `Make a short podcast for teammates who did not follow the work. Two hosts: Maya explains, Jonah asks the questions a teammate would ask.
- Start with the symptom a user saw, in one or two lines.
- Spend most of the time on WHY: what we considered, what we rejected, and the constraint that decided it.
- Then explain HOW it was built: walk through the key code, one idea per highlighted block, and say what each block is for.
- Ground every claim in the real diff and commit messages. Name real files, commits and versions, but say them in plain words.
- Show the logic with a diagram, comparison or timeline whenever a sentence describes a sequence or a choice.
- Split the story into chapters and give each one a location that fits what it does: podcast studio to open, classroom to teach a concept, lecture hall for a code walk-through, coffee house to argue options, street walk or train ride for what happened over time, server room for the state of machines, the matrix for low-level code, rooftop at dawn to wrap up. Do not use the same location for two chapters in a row.
- Give each chapter a mood (calm, tension, insight, resolved) so the setting evolves with the story: tension while it is broken, insight when the cause or the idea lands, resolved at the end.
- End with a recap: what changed, why, what we give up, and how you would notice.
- 18 to 26 lines in total, each under 40 words. Friendly, no hype.
When a viewer asks a follow-up question: continue the same story with 1 or 2 new chapters, 4 to 8 lines, in fitting locations. Jonah voices the question, Maya answers, and each point gets one visual. Say so plainly if the history does not contain the answer.`;

export const storySettingsSchema = z.object({
  /** Steers every story and every follow-up answer. Empty uses the default. */
  instructions: z.string().max(6000),
  /** Off keeps every chapter in the podcast studio. */
  backdrops: z.boolean(),
  /** Locations the writer may use; a chapter in a location that is off is shown in the podcast studio. */
  locations: z.array(z.enum(STORY_LOCATIONS)).max(STORY_LOCATIONS.length),
  /** Rain, red light, a light bulb and sunrise that follow each chapter's mood. */
  moods: z.boolean(),
  /** Code snippets on the slides, highlighted and explained step by step. */
  codeSlides: z.boolean(),
  /** The same code with a line-by-line explanation in the written section. */
  codeWriteup: z.boolean(),
  maxCodeLines: z.number().int().min(4).max(24),
  /** Viewers may ask follow-up questions that continue the story. */
  ask: z.boolean(),
  narrate: z.boolean(),
  /** auto: Kokoro when this node can run it, otherwise ElevenLabs when the project has a key. */
  voiceProvider: z.enum(VOICE_PROVIDER_CHOICES),
  hostVoice: z.enum(KOKORO_VOICES),
  cohostVoice: z.enum(KOKORO_VOICES),
  /** ElevenLabs voice IDs, from the account's voice library. */
  elevenHostVoice: z.string().regex(ELEVEN_VOICE_ID, "Use an ElevenLabs voice ID"),
  elevenCohostVoice: z.string().regex(ELEVEN_VOICE_ID, "Use an ElevenLabs voice ID"),
  speed: z.number().min(0.7).max(1.3),
  /** False until the viewer picks a voice on this node, the first time they make a story or an Activity overview. */
  voiceChosen: z.boolean().default(false),
}).strict().refine((settings) => !settings.backdrops || settings.locations.length > 0, { message: "Choose at least one location, or turn locations off", path: ["locations"] });
export type StorySettings = z.infer<typeof storySettingsSchema>;

export const DEFAULT_STORY_SETTINGS: StorySettings = {
  instructions: DEFAULT_STORY_INSTRUCTIONS,
  backdrops: true,
  locations: [...STORY_LOCATIONS],
  moods: true,
  codeSlides: true,
  codeWriteup: true,
  maxCodeLines: 12,
  ask: true,
  narrate: true,
  voiceProvider: "auto",
  hostVoice: "af_heart",
  cohostVoice: "am_michael",
  elevenHostVoice: "EXAVITQu4vr4xnSDxMaL",
  elevenCohostVoice: "CwhRBWXzGAHq8TQ4Fs17",
  speed: 1,
  voiceChosen: false,
};

export function getStorySettings(): StorySettings {
  const stored = value(SETTINGS_KEY);
  if (!stored) return structuredClone(DEFAULT_STORY_SETTINGS);
  const parsed = storySettingsSchema.safeParse(JSON.parse(stored));
  return parsed.success ? parsed.data : structuredClone(DEFAULT_STORY_SETTINGS);
}

export function updateStorySettings(input: unknown): StorySettings {
  const settings = storySettingsSchema.parse(input);
  save(settingsDatabase(), SETTINGS_KEY, JSON.stringify(settings));
  return settings;
}

/** What the writer is told: the saved instructions, or the default when they are empty. */
export const storyInstructions = (settings: StorySettings): string => settings.instructions.trim() || DEFAULT_STORY_INSTRUCTIONS;
