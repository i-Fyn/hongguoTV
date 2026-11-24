import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { __testing } from "../server/playback.mjs";

const resources = new URL(
  "../kotlin-tv/core/src/test/resources/",
  import.meta.url
);
const envelope = new URL("./fixtures/hongguo-signing-v5-envelope.json", import.meta.url);
const hex = (value) => Buffer.from(value, "hex");

test("v5 medusa digest matches the verified Android wire vectors", () => {
  const vectors = JSON.parse(
    fs.readFileSync(new URL("signing-v5-f13.json", resources), "utf8")
  );
  assert.equal(vectors.length, 32);
  for (const row of vectors) {
    const digest = __testing
      .hashF13(hex(row.query), hex(row.body), row.ts)
      .subarray(0, 16)
      .toString("hex");
    assert.equal(digest, row.digest, `timestamp class ${row.ts}`);
  }
});

test("v5 carrier matches all four timestamp variants", () => {
  const rows = JSON.parse(
    fs.readFileSync(new URL("signing-v5-carrier.json", resources), "utf8")
  );
  for (const row of rows)
    assert.equal(
      new __testing.AesV3(hex(row.key), row.ts)
        .encrypt(hex(row.source), hex(row.iv))
        .toString("hex"),
      row.encrypted,
      `carrier variant ${row.ts}`
    );
});

test("v5 playback envelope matches the official device-profile form", () => {
  const rows = JSON.parse(fs.readFileSync(envelope, "utf8"));
  for (const row of rows) {
    const context = {
      messageRand: 0x80000000,
      envLaunch: 105,
      envPid: 11000,
      nowUnix: row.ts,
      signNonce: 0x80000000,
      packedRand: 0x80000000,
    };
    assert.equal(
      __testing.medusaV5(
        row.url,
        hex(row.body),
        row.ts,
        { device_id: "123" },
        { nonce: "synthetic", started: 1800000000000 },
        context
      ),
      row.medusa
    );
    assert.equal(__testing.heliosV5(row.ts, 0x80000000), row.helios);
  }
});
