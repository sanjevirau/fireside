import { median, theilSenBytesPerHour } from "./statistics.ts";

export interface ResidentSample {
  readonly elapsedSeconds: number;
  readonly rssBytes: number;
}

export interface HarmonicFit {
  readonly amplitudeBytes: number;
  readonly phaseRadians: number;
  readonly rSquared: number;
  readonly trendBytesPerHour: number;
}

export interface JointHarmonicFit {
  readonly periodSeconds: number;
  readonly fits: readonly HarmonicFit[];
  readonly normalizedResidualScore: number;
}

function solveLinearSystem(matrix: readonly (readonly number[])[], values: readonly number[]): number[] {
  const width = values.length;
  const rows = matrix.map((row, index) => [...row, values[index] ?? 0]);
  for (let column = 0; column < width; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < width; row += 1) {
      if (Math.abs(rows[row]?.[column] ?? 0) > Math.abs(rows[pivot]?.[column] ?? 0)) {
        pivot = row;
      }
    }
    [rows[column], rows[pivot]] = [rows[pivot] ?? [], rows[column] ?? []];
    const divisor = rows[column]?.[column] ?? 0;
    if (Math.abs(divisor) < Number.EPSILON) {
      throw new Error("harmonic fit matrix is singular");
    }
    for (let entry = column; entry <= width; entry += 1) {
      const pivotRow = rows[column];
      if (pivotRow === undefined) {
        throw new Error("harmonic fit pivot row disappeared");
      }
      pivotRow[entry] = (pivotRow[entry] ?? 0) / divisor;
    }
    for (let row = 0; row < width; row += 1) {
      if (row === column) {
        continue;
      }
      const factor = rows[row]?.[column] ?? 0;
      for (let entry = column; entry <= width; entry += 1) {
        const targetRow = rows[row];
        const pivotRow = rows[column];
        if (targetRow === undefined || pivotRow === undefined) {
          throw new Error("harmonic fit row disappeared");
        }
        targetRow[entry] = (targetRow[entry] ?? 0)
          - factor * (pivotRow[entry] ?? 0);
      }
    }
  }
  return rows.map((row) => row[width] ?? 0);
}

export function fitHarmonic(
  samples: readonly ResidentSample[],
  periodSeconds: number,
): HarmonicFit & { readonly normalizedResidualScore: number } {
  if (samples.length < 4 || periodSeconds <= 0) {
    throw new Error("harmonic fitting requires four samples and a positive period");
  }
  const centerSeconds = median(samples.map((sample) => sample.elapsedSeconds)) ?? 0;
  const angularFrequency = 2 * Math.PI / periodSeconds;
  const normalMatrix = Array.from({ length: 4 }, () => Array<number>(4).fill(0));
  const normalValues = Array<number>(4).fill(0);
  for (const sample of samples) {
    const elapsed = sample.elapsedSeconds - centerSeconds;
    const basis = [
      1,
      elapsed,
      Math.sin(angularFrequency * elapsed),
      Math.cos(angularFrequency * elapsed),
    ];
    for (let row = 0; row < basis.length; row += 1) {
      normalValues[row] = (normalValues[row] ?? 0) + (basis[row] ?? 0) * sample.rssBytes;
      for (let column = 0; column < basis.length; column += 1) {
        const matrixRow = normalMatrix[row];
        if (matrixRow !== undefined) {
          matrixRow[column] = (matrixRow[column] ?? 0)
            + (basis[row] ?? 0) * (basis[column] ?? 0);
        }
      }
    }
  }
  const coefficients = solveLinearSystem(normalMatrix, normalValues);
  const mean = samples.reduce((total, sample) => total + sample.rssBytes, 0) / samples.length;
  let residualSquares = 0;
  let totalSquares = 0;
  for (const sample of samples) {
    const elapsed = sample.elapsedSeconds - centerSeconds;
    const predicted = (coefficients[0] ?? 0)
      + (coefficients[1] ?? 0) * elapsed
      + (coefficients[2] ?? 0) * Math.sin(angularFrequency * elapsed)
      + (coefficients[3] ?? 0) * Math.cos(angularFrequency * elapsed);
    residualSquares += (sample.rssBytes - predicted) ** 2;
    totalSquares += (sample.rssBytes - mean) ** 2;
  }
  const normalizedResidualScore = totalSquares === 0 ? 0 : residualSquares / totalSquares;
  return {
    amplitudeBytes: Math.hypot(coefficients[2] ?? 0, coefficients[3] ?? 0),
    phaseRadians: Math.atan2(coefficients[3] ?? 0, coefficients[2] ?? 0),
    rSquared: 1 - normalizedResidualScore,
    trendBytesPerHour: (coefficients[1] ?? 0) * 3_600,
    normalizedResidualScore,
  };
}

export function findJointHarmonicPeriod(
  runs: readonly (readonly ResidentSample[])[],
  minimumPeriodSeconds: number,
  maximumPeriodSeconds: number,
): JointHarmonicFit {
  if (runs.length === 0 || minimumPeriodSeconds > maximumPeriodSeconds) {
    throw new Error("joint harmonic fitting requires runs and an ordered period range");
  }
  let best: JointHarmonicFit | undefined;
  for (let period = minimumPeriodSeconds; period <= maximumPeriodSeconds; period += 1) {
    const fits = runs.map((samples) => fitHarmonic(samples, period));
    const score = fits.reduce((total, fit) => total + fit.normalizedResidualScore, 0);
    if (best === undefined || score < best.normalizedResidualScore) {
      best = {
        periodSeconds: period,
        fits,
        normalizedResidualScore: score,
      };
    }
  }
  if (best === undefined) {
    throw new Error("joint harmonic fit did not produce a candidate");
  }
  return best;
}

export function circularPhaseSlopes(samples: readonly ResidentSample[]): number[] {
  if (samples.length < 2) {
    return [];
  }
  const intervals = samples.slice(1).map((sample, index) =>
    sample.elapsedSeconds - (samples[index]?.elapsedSeconds ?? sample.elapsedSeconds)
  );
  const intervalSeconds = median(intervals);
  if (intervalSeconds === null || intervalSeconds <= 0) {
    throw new Error("phase sensitivity requires increasing sample times");
  }
  return samples.map((_, offset) => {
    const rotated = [...samples.slice(offset), ...samples.slice(0, offset)].map(
      (sample, index) => ({
        elapsedSeconds: index * intervalSeconds,
        rssBytes: sample.rssBytes,
      }),
    );
    const slope = theilSenBytesPerHour(rotated);
    if (slope === null) {
      throw new Error("phase sensitivity did not produce a slope");
    }
    return slope;
  });
}

export function interpolatedQuantile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0 || fraction < 0 || fraction > 1) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}
