/** Waits until `isConditionMet()` is true, polling every 5ms (up to 1s). */
export async function waitFor(isConditionMet: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (!isConditionMet()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
