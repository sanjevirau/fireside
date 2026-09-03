/** Include both window endpoints, including a non-divisible final interval. */
export function phase5SoakSampleOffsets(durationSeconds: number, intervalSeconds: number): number[] {
  if (!Number.isFinite(durationSeconds) || !Number.isFinite(intervalSeconds) ||
      durationSeconds <= 0 || intervalSeconds <= 0) {
    throw new Error("Soak duration and sample interval must be positive finite seconds");
  }
  const count = Math.ceil(durationSeconds / intervalSeconds) + 1;
  return Array.from({ length: count }, (_, index) => Math.min(index * intervalSeconds, durationSeconds) * 1_000);
}
