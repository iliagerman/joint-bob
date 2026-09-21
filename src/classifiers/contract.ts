/** A difficulty classification of one prompt, on a 1 to 10 scale. */
export interface DifficultyClassification {
  /** 1 to 10, the discrete level used for model mapping. */
  level: number;
  /** Probability-weighted level value on the same 1 to 10 scale, for display. */
  score: number;
  /** Classifier confidence from 0 to 1. Low confidence falls back to conversation settings. */
  confidence: number;
}

/** A pluggable prompt-difficulty classifier. Implementations must never throw
    from classify(): a failed evaluation returns null and the caller falls back
    to the conversation's current model settings. */
export interface DifficultyClassifier {
  id: string;
  label: string;
  /** Environment variable that carries the API key, resolved from attached secret accounts. */
  variableName: string;
  classify(text: string, apiKey: string): Promise<DifficultyClassification | null>;
}
