import { automationProfileContext } from "../../src/provider-profiles/context.js";
export default async function (): Promise<string> {
  await Promise.resolve();
  return JSON.stringify(automationProfileContext());
}
