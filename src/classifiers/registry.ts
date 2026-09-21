import type { DifficultyClassifier } from "./contract.js";
import { typesafeClassifier } from "./typesafe.js";

const classifiers: DifficultyClassifier[] = [typesafeClassifier];

export function listDifficultyClassifiers(): DifficultyClassifier[] {
  return [...classifiers];
}

export function getDifficultyClassifier(id: string): DifficultyClassifier | undefined {
  return classifiers.find((classifier) => classifier.id === id);
}
