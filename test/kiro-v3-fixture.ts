/** Initialization payload for synthetic V3 fixtures; the strict wire test validates the adapter separately. */
export const kiroV3SessionFixture = `
function v3Session(request, sessionId) {
  const initial = request.params._meta.kiro;
  const values = {mode:initial.modeId, model:initial.modelId || 'fixture-model', effortLevel:initial.effortLevel, autopilot:'off'};
  return {
    sessionId,
    modes:{currentModeId:initial.modeId,availableModes:[{id:initial.modeId,name:initial.modeId}]},
    configOptions:Object.entries(values).map(([id,value])=>({id,type:'select',currentValue:value,options:[{value,name:value}]}))
  };
}
`;
