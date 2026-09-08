import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeCaptureFixture,
  decodeLengthPrefixedFrames,
  type CaptureFixture,
} from "../src/webchannel/capture-contract.ts";

test("WebChannel frame lengths count decoded UTF-16 code units", () => {
  const payloads = [
    JSON.stringify(["東京"]),
    JSON.stringify(["emoji-😀"]),
    JSON.stringify(["混合-😀-é"]),
  ];
  const body = payloads.map((payload) => `${String(payload.length)}\n${payload}`).join("");

  const frames = decodeLengthPrefixedFrames(body);

  assert.equal(frames.length, payloads.length);
  assert.deepEqual(
    frames.map((frame) => frame.declaredUtf16CodeUnits),
    payloads.map((payload) => payload.length),
  );
  assert.ok(frames.some((frame) => frame.utf8Bytes > frame.observedUtf16CodeUnits));
});

test("capture decoder preserves form order and exposes framed responses", () => {
  const responseText = "7\n[1,2,0]";
  const fixture: CaptureFixture = {
    schemaVersion: 1,
    metadata: {
      hypothesis: "forward acknowledgement",
      target: "java-v1.22.0",
      targetVersion: "1.22.0",
      sdk: "firebase@12.18.0",
      recordedAt: "2026-08-31T00:00:00Z",
      transport: "web-channel",
    },
    exchanges: [
      {
        sequence: 1,
        request: {
          method: "POST",
          uri: "/Listen/channel?VER=8&RID=1",
          headers: [
            {
              name: "content-type",
              value: "application/x-www-form-urlencoded; charset=UTF-8",
            },
          ],
          bodyBase64: Buffer.from("count=1&ofs=0", "utf8").toString("base64"),
        },
        response: {
          status: 200,
          headers: [],
          bodyBase64: Buffer.from(responseText, "utf8").toString("base64"),
        },
      },
    ],
  };

  const contract = decodeCaptureFixture(fixture);

  assert.deepEqual(contract.exchanges[0]?.request.form, [
    ["count", "1"],
    ["ofs", "0"],
  ]);
  assert.deepEqual(contract.exchanges[0]?.response.frames[0]?.json, [1, 2, 0]);
});
