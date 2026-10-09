import * as service from "../../pi-service.js";
async function piModels() {
  return (await service.listAvailableModels()).map((model) => ({
    ...model,
    thinkingLevels: service.modelThinkingLevels(model.provider, model.id),
    ...["openai", "openai-codex"].includes(model.provider) ? { providerLabel: "GPT", providerIcon: "openai" } : model.provider === "zai" ? { providerLabel: "GLM" } : {}
  }));
}
export {
  piModels
};
