function priceUsage(tokens, rates) {
  const values = [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite5m, tokens.cacheWrite1h];
  if (values.some((value) => value === null)) return null;
  const input = tokens.input;
  const totalInput = input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
  const tier = [...rates.inputTiers ?? []].sort((a, b) => b.threshold - a.threshold).find((candidate) => totalInput > candidate.threshold);
  const selected = tier ? { ...rates, ...tier } : rates;
  const read = selected.cacheRead;
  const write5m = selected.cacheWrite5m ?? selected.cacheWrite;
  const write1h = selected.cacheWrite1h;
  if (tokens.cacheRead > 0 && read === void 0 || tokens.cacheWrite5m > 0 && write5m === void 0 || tokens.cacheWrite1h > 0 && write1h === void 0) return null;
  const applicableRates = [selected.input, selected.output ?? rates.output, read ?? 0, write5m ?? 0, write1h ?? 0];
  if (totalInput + tokens.output > 0 && applicableRates.every((value) => value === 0)) return null;
  return (input * selected.input + tokens.output * (selected.output ?? rates.output) + tokens.cacheRead * (read ?? 0) + tokens.cacheWrite5m * (write5m ?? 0) + tokens.cacheWrite1h * (write1h ?? 0)) / 1e6;
}
export {
  priceUsage
};
