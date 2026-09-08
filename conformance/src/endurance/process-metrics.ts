import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { freemem, loadavg } from "node:os";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface ProcessSample {
  readonly rssBytes: number;
  readonly peakRssBytes: number;
  readonly processSwapBytes: number;
  readonly pssBytes: number;
  readonly anonymousBytes: number;
  readonly privateCleanBytes: number;
  readonly privateDirtyBytes: number;
  readonly sharedCleanBytes: number;
  readonly sharedDirtyBytes: number;
  readonly lazyFreeBytes: number;
  readonly anonymousHugePagesBytes: number;
  readonly systemAvailableBytes: number;
  readonly systemSwapUsedBytes: number;
  readonly loadOne: number;
}

export async function sampleProcess(pid: number): Promise<ProcessSample> {
  if (process.platform !== "linux") {
    const result = await execute("ps", ["-o", "rss=", "-p", String(pid)]);
    const rssBytes = Number.parseInt(result.stdout.trim(), 10) * 1_024;
    if (!Number.isFinite(rssBytes)) {
      throw new Error(`cannot read RSS for process ${String(pid)}`);
    }
    return {
      rssBytes,
      peakRssBytes: rssBytes,
      processSwapBytes: 0,
      pssBytes: rssBytes,
      anonymousBytes: 0,
      privateCleanBytes: 0,
      privateDirtyBytes: 0,
      sharedCleanBytes: 0,
      sharedDirtyBytes: 0,
      lazyFreeBytes: 0,
      anonymousHugePagesBytes: 0,
      systemAvailableBytes: freemem(),
      systemSwapUsedBytes: 0,
      loadOne: loadavg()[0] ?? 0,
    };
  }
  const [status, smaps, memory, load] = await Promise.all([
    readFile(`/proc/${String(pid)}/status`, "utf8"),
    readFile(`/proc/${String(pid)}/smaps_rollup`, "utf8"),
    readFile("/proc/meminfo", "utf8"),
    readFile("/proc/loadavg", "utf8"),
  ]);
  const swapTotal = memoryKilobytes(memory, "SwapTotal");
  const swapFree = memoryKilobytes(memory, "SwapFree");
  return {
    rssBytes: statusKilobytes(status, "VmRSS"),
    peakRssBytes: statusKilobytes(status, "VmHWM"),
    processSwapBytes: statusKilobytes(status, "VmSwap"),
    ...parseSmapsRollup(smaps),
    systemAvailableBytes: memoryKilobytes(memory, "MemAvailable"),
    systemSwapUsedBytes: Math.max(0, swapTotal - swapFree),
    loadOne: Number.parseFloat(load.split(/\s+/u)[0] ?? "NaN"),
  };
}

export function parseSmapsRollup(contents: string): Pick<
  ProcessSample,
  | "pssBytes"
  | "anonymousBytes"
  | "privateCleanBytes"
  | "privateDirtyBytes"
  | "sharedCleanBytes"
  | "sharedDirtyBytes"
  | "lazyFreeBytes"
  | "anonymousHugePagesBytes"
> {
  return {
    pssBytes: statusKilobytes(contents, "Pss"),
    anonymousBytes: statusKilobytes(contents, "Anonymous"),
    privateCleanBytes: statusKilobytes(contents, "Private_Clean"),
    privateDirtyBytes: statusKilobytes(contents, "Private_Dirty"),
    sharedCleanBytes: statusKilobytes(contents, "Shared_Clean"),
    sharedDirtyBytes: statusKilobytes(contents, "Shared_Dirty"),
    lazyFreeBytes: statusKilobytes(contents, "LazyFree"),
    anonymousHugePagesBytes: statusKilobytes(contents, "AnonHugePages"),
  };
}

function statusKilobytes(contents: string, field: string): number {
  const match = contents.match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "mu"));
  if (match?.[1] === undefined) {
    return 0;
  }
  return Number.parseInt(match[1], 10) * 1_024;
}

function memoryKilobytes(contents: string, field: string): number {
  return statusKilobytes(contents, field);
}
