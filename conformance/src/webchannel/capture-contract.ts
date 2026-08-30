import { Buffer } from "node:buffer";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export interface CaptureFixture {
  readonly schemaVersion: number;
  readonly metadata: {
    readonly hypothesis: string;
    readonly target: string;
    readonly targetVersion: string;
    readonly sdk: string;
    readonly recordedAt: string;
    readonly transport: string;
  };
  readonly exchanges: readonly CapturedExchange[];
}

interface CapturedExchange {
  readonly sequence: number;
  readonly request: CapturedRequest;
  readonly response: CapturedResponse;
}

interface CapturedRequest {
  readonly method: string;
  readonly uri: string;
  readonly headers: readonly CapturedHeader[];
  readonly bodyBase64?: string | null;
}

interface CapturedResponse {
  readonly status: number;
  readonly headers: readonly CapturedHeader[];
  readonly bodyBase64?: string | null;
  readonly bodyChunksBase64?: readonly string[];
}

interface CapturedHeader {
  readonly name: string;
  readonly value: string;
}

interface DecodedFrame {
  readonly declaredUtf16CodeUnits: number;
  readonly observedUtf16CodeUnits: number;
  readonly utf8Bytes: number;
  readonly text: string;
  readonly json?: unknown;
}

export interface DecodedCaptureContract {
  readonly schemaVersion: 1;
  readonly fixtureSchemaVersion: number;
  readonly metadata: CaptureFixture["metadata"];
  readonly exchanges: readonly DecodedExchange[];
}

interface DecodedExchange {
  readonly sequence: number;
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly query: readonly [string, string][];
    readonly headers: readonly CapturedHeader[];
    readonly form?: readonly [string, string][];
    readonly bodyText?: string;
  };
  readonly response: {
    readonly status: number;
    readonly headers: readonly CapturedHeader[];
    readonly chunks: readonly {
      readonly bodyBase64: string;
      readonly bytes: number;
      readonly text?: string;
      readonly utf16CodeUnits?: number;
      readonly utf8Bytes: number;
    }[];
    readonly frames: readonly DecodedFrame[];
    readonly bodyText?: string;
  };
}

export function decodeCaptureFixture(
  fixture: CaptureFixture,
): DecodedCaptureContract {
  if (fixture.schemaVersion !== 1) {
    throw new Error(
      `unsupported WebChannel capture fixture schema ${String(fixture.schemaVersion)}`,
    );
  }

  return {
    schemaVersion: 1,
    fixtureSchemaVersion: fixture.schemaVersion,
    metadata: fixture.metadata,
    exchanges: fixture.exchanges.map(decodeExchange),
  };
}

export function decodeLengthPrefixedFrames(body: string): DecodedFrame[] {
  const frames: DecodedFrame[] = [];
  let cursor = 0;

  while (cursor < body.length) {
    const newline = body.indexOf("\n", cursor);
    if (newline < 0) {
      return [];
    }
    const prefix = body.slice(cursor, newline);
    if (!/^\d+$/u.test(prefix)) {
      return [];
    }
    const declaredUtf16CodeUnits = Number(prefix);
    const payloadStart = newline + 1;
    const payloadEnd = payloadStart + declaredUtf16CodeUnits;
    if (!Number.isSafeInteger(declaredUtf16CodeUnits) || payloadEnd > body.length) {
      throw new Error(
        `invalid WebChannel frame length ${prefix} at UTF-16 offset ${String(cursor)}`,
      );
    }
    const text = body.slice(payloadStart, payloadEnd);
    const frame: DecodedFrame = {
      declaredUtf16CodeUnits,
      observedUtf16CodeUnits: text.length,
      utf8Bytes: Buffer.byteLength(text, "utf8"),
      text,
    };
    try {
      frames.push({ ...frame, json: JSON.parse(text) as unknown });
    } catch {
      frames.push(frame);
    }
    cursor = payloadEnd;
  }

  return frames;
}

function decodeExchange(exchange: CapturedExchange): DecodedExchange {
  const requestUrl = new URL(exchange.request.uri, "http://capture.invalid");
  const requestBody = decodeBody(exchange.request.bodyBase64);
  const contentEncoding = headerValue(
    exchange.response.headers,
    "content-encoding",
  );
  const responseBody = decodeResponseBody(
    exchange.response.bodyBase64,
    contentEncoding,
  );
  const contentType = headerValue(exchange.request.headers, "content-type");
  const request = {
    method: exchange.request.method,
    path: requestUrl.pathname,
    query: [...requestUrl.searchParams.entries()],
    headers: exchange.request.headers,
    ...(requestBody === undefined
      ? {}
      : contentType?.startsWith("application/x-www-form-urlencoded") === true
        ? { form: [...new URLSearchParams(requestBody).entries()] }
        : { bodyText: requestBody }),
  };
  const frames = responseBody === undefined
    ? []
    : decodeLengthPrefixedFrames(responseBody);
  const chunks = (exchange.response.bodyChunksBase64 ?? []).map((chunk) => {
    const bytes = Buffer.from(chunk, "base64");
    if (contentEncoding !== undefined) {
      return {
        bodyBase64: chunk,
        bytes: bytes.length,
        utf8Bytes: bytes.length,
      };
    }
    const text = bytes.toString("utf8");
    return {
      bodyBase64: chunk,
      bytes: bytes.length,
      text,
      utf16CodeUnits: text.length,
      utf8Bytes: Buffer.byteLength(text, "utf8"),
    };
  });

  return {
    sequence: exchange.sequence,
    request,
    response: {
      status: exchange.response.status,
      headers: exchange.response.headers,
      chunks,
      frames,
      ...(responseBody === undefined || frames.length > 0
        ? {}
        : { bodyText: responseBody }),
    },
  };
}

function decodeResponseBody(
  bodyBase64: string | null | undefined,
  contentEncoding: string | undefined,
): string | undefined {
  if (bodyBase64 === undefined || bodyBase64 === null) {
    return undefined;
  }
  const body = Buffer.from(bodyBase64, "base64");
  switch (contentEncoding?.toLowerCase()) {
    case undefined:
    case "identity":
      return body.toString("utf8");
    case "br":
      return brotliDecompressSync(body).toString("utf8");
    case "deflate":
      return inflateSync(body).toString("utf8");
    case "gzip":
      return gunzipSync(body).toString("utf8");
    default:
      throw new Error(`unsupported capture content encoding ${contentEncoding}`);
  }
}

function decodeBody(bodyBase64: string | null | undefined): string | undefined {
  return bodyBase64 === undefined || bodyBase64 === null
    ? undefined
    : Buffer.from(bodyBase64, "base64").toString("utf8");
}

function headerValue(
  headers: readonly CapturedHeader[],
  name: string,
): string | undefined {
  return headers.find((header) =>
    header.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0
  )?.value;
}
