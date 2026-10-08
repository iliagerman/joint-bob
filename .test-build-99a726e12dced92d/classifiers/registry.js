import { typesafeClassifier } from "./typesafe.js";
const classifiers = [typesafeClassifier];
function listDifficultyClassifiers() {
  return [...classifiers];
}
function getDifficultyClassifier(id) {
  return classifiers.find((classifier) => classifier.id === id);
}
export {
  getDifficultyClassifier,
  listDifficultyClassifiers
};
