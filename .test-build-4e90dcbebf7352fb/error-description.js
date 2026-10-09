function describeError(error) {
  const parts = [];
  for (let current = error; current instanceof Error; current = current.cause) parts.push(current.message);
  return parts.length ? parts.join(": ") : String(error);
}
export {
  describeError
};
