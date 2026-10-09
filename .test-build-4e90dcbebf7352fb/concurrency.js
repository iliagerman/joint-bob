async function mapWithConcurrency(items, limit, map) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await map(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
export {
  mapWithConcurrency
};
