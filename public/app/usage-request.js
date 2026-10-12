/* An aborted old scope is never replayed; a single timeout may be retried safely (GET only). */
export async function requestComparison(path, fetchDays, signal, timeoutMs = 30000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetchDays(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
    } catch (error) {
      if (attempt || signal.aborted || !["TimeoutError", "AbortError"].includes(error.name)) throw error;
    }
  }
}
