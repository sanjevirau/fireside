import {
  closeSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export class DurableLog {
  readonly #descriptor: number;

  constructor(path: string, header?: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#descriptor = openSync(path, "a", 0o644);
    if (header !== undefined) {
      this.write(header);
    }
  }

  write(line: string): void {
    writeSync(this.#descriptor, line.endsWith("\n") ? line : `${line}\n`);
    fdatasyncSync(this.#descriptor);
  }

  json(value: unknown): void {
    this.write(JSON.stringify(value));
  }

  close(): void {
    closeSync(this.#descriptor);
  }
}
