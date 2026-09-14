import { canonicalTranscriptName } from "../shared-paths.js";

const PI_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/;

export function canonicalPiTranscriptName(fileName: string): string {
  return canonicalTranscriptName(fileName);
}

export function piSessionIdFromFileName(fileName: string): string {
  return canonicalPiTranscriptName(fileName).replace(/\.jsonl$/, "").replace(PI_TIMESTAMP_PREFIX, "");
}
