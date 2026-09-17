import { setTimeout as delay } from "node:timers/promises";

export async function waitForAssertion<T>(condition: () => Promise<T>, timeout = 1000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      return await condition();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(Math.min(50, deadline - Date.now()));
    }
  }
}
