import type { DifficultyClassifier } from "./contract.js";
import { classifyWithSystemOne } from "./typesafe.js";

/**
 * Laya answers the same requests as Jev. It runs where Settings → Classifiers says: on another
 * machine at the saved address, otherwise on this machine once installed. Its multilingual
 * checkpoint reads about 3,500 characters, so the newest part of the prompt is what it judges.
 */
export const layaClassifier: DifficultyClassifier = {
  id: "laya",
  label: "Laya",
  variableName: "LAYA_API_KEY",
  keyOptional: true,
  classify: async (text, apiKey, context) => {
    try {
      const { getGuardianSettings } = await import("../guardian/settings.js");
      const { localLayaUrl } = await import("../guardian/laya.js");
      const remote = getGuardianSettings().layaUrl;
      const base = remote || await localLayaUrl();
      return await classifyWithSystemOne({ endpoint: `${base.replace(/\/+$/, "")}/v1/systemone`, model: "multilingual", stateCharacters: 3_500, timeoutMs: remote ? 20_000 : 120_000 }, text, remote ? apiKey : "", context);
    } catch {
      return null;
    }
  },
};
