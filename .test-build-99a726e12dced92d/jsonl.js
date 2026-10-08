function parseCompletedJsonl(contents) {
  const lines = contents.split("\n");
  const tail = lines.pop();
  const records = lines.filter((line) => line.trim()).map((line) => JSON.parse(line));
  if (tail.trim()) {
    try {
      records.push(JSON.parse(tail));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return records;
}
export {
  parseCompletedJsonl
};
