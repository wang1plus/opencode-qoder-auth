import assert from "node:assert/strict";
import test from "node:test";
import {
  qoderDecodeBody,
  qoderEncodeBody,
} from "../dist/qoder-encoding.js";

test("WAF encoding round-trips every body length", () => {
  for (let length = 0; length <= 256; length++) {
    const input = "x".repeat(length);
    const encoded = qoderEncodeBody(input);
    assert.equal(qoderDecodeBody(encoded), input, `length ${length}`);
  }
});

test("WAF encoding round-trips multibyte UTF-8 and JSON", () => {
  const body = JSON.stringify({
    system: "你是 Qoder 助手",
    messages: [{ role: "user", content: "解释一下 COSY 签名 🚀" }],
  });
  assert.equal(qoderDecodeBody(qoderEncodeBody(body)), body);
});

test("WAF encoding permutes the base64 alphabet", () => {
  const input = "hello world";
  const encoded = qoderEncodeBody(input);
  const standard = Buffer.from(input).toString("base64");
  assert.notEqual(encoded, standard);
  assert.match(
    encoded,
    /^[_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$]+$/,
  );
});

test("WAF encoding replaces base64 padding with $", () => {
  // One byte encodes to a base64 string with `==` padding.
  const encoded = qoderEncodeBody("a");
  assert.match(encoded, /\$/);
  assert.equal(qoderDecodeBody(encoded), "a");
});
