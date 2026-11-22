export type Limited = <T>(task: () => Promise<T>) => Promise<T>;

/** Runs at most `maxInFlight` tasks at once; the rest wait in order. */
export function limitConcurrency(maxInFlight: number): Limited {
  let inFlight = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (inFlight >= maxInFlight) await new Promise<void>((resolve) => waiting.push(resolve));
    inFlight++;
    try {
      return await task();
    } finally {
      inFlight--;
      waiting.shift()?.();
    }
  };
}
