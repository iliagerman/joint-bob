import { canonicalTranscriptName } from "../shared-paths.js";
const PI_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/;
function canonicalPiTranscriptName(fileName) {
  return canonicalTranscriptName(fileName);
}
function piSessionIdFromFileName(fileName) {
  return canonicalPiTranscriptName(fileName).replace(/\.jsonl$/, "").replace(PI_TIMESTAMP_PREFIX, "");
}
export {
  canonicalPiTranscriptName,
  piSessionIdFromFileName
};
