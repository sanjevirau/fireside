export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function theilSenBytesPerHour(
  samples: ReadonlyArray<{ readonly elapsedSeconds: number; readonly rssBytes: number }>,
): number | null {
  if (samples.length < 2) {
    return null;
  }
  const slopes: number[] = [];
  for (let left = 0; left < samples.length - 1; left += 1) {
    const start = samples[left];
    if (start === undefined) {
      continue;
    }
    for (let right = left + 1; right < samples.length; right += 1) {
      const end = samples[right];
      if (end === undefined || end.elapsedSeconds === start.elapsedSeconds) {
        continue;
      }
      slopes.push(
        ((end.rssBytes - start.rssBytes) / (end.elapsedSeconds - start.elapsedSeconds))
          * 3_600,
      );
    }
  }
  return median(slopes);
}

export function sustainedWindowTheilSenBytesPerHour(
  samples: ReadonlyArray<{ readonly elapsedSeconds: number; readonly rssBytes: number }>,
  warmupSeconds: number,
  windowSeconds: number,
): number | null {
  const latest = samples.at(-1)?.elapsedSeconds;
  if (latest === undefined || latest < warmupSeconds + windowSeconds) {
    return null;
  }
  const windowStart = latest - windowSeconds;
  return theilSenBytesPerHour(
    samples.filter((sample) => sample.elapsedSeconds >= windowStart),
  );
}
