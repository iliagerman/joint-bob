// The summary writer every test node uses unless a test passes its own (see test/setup.mjs):
// summaries after each answer must not open agent sessions a test did not ask for.
export default async ({ material }) => `**Goal** — ${(/User: (.*)/.exec(material)?.[1] ?? "the work").slice(0, 120)}`;
