// Failure modes: published schemas accept an impersonated source, malformed receipts, or credentials in event data;
// the wire contract drifts from the validators, and conformance accepts a server that opens the wrong door.
// Required job structure and inherited object names must not bypass schema checks; Unicode limits count code points.
// FYI notices must accept only an optional boolean without weakening notice limits or changing question receipts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSchema } from "../protocol/schema.ts";
import { parseEvent, parseResult } from "../protocol/validate.ts";

test("notice receipts accept an optional boolean fyi and keep all other boundaries", () => {
  const notice = { title: "Уже установлено", text: "каждый день九点Проверить", key: "daily-check" };
  for (const item of [notice, { ...notice, fyi: true }, { ...notice, fyi: false }]) {
    const result = { outcome: "done", notice: [item] };
    assert.deepEqual(parseResult(result), result);
    assert.deepEqual(checkSchema("result", result), []);
  }
  for (const item of [
    ...[null, 0, 1, "true", [], {}].map((fyi) => ({ ...notice, fyi })),
    { ...notice, fyi: true, title: "" },
    { ...notice, fyi: true, title: "x".repeat(201) },
    { ...notice, fyi: true, text: " " },
    { ...notice, fyi: true, text: "x".repeat(4001) },
    { ...notice, fyi: true, key: "x".repeat(101) },
    { ...notice, fyi: true, unknown: true },
  ]) {
    const result = { outcome: "done", notice: [item] };
    assert.throws(() => parseResult(result), /notice/);
    assert.ok(checkSchema("result", result).length);
  }
  const tooMany = { outcome: "done", notice: Array(11).fill({ ...notice, fyi: true }) };
  assert.throws(() => parseResult(tooMany), /notice/);
  assert.ok(checkSchema("result", tooMany).length);
  const ask = { outcome: "done", ask: [{ ...notice, options: ["Продолжить", "暂停"], fyi: true }] };
  assert.throws(() => parseResult(ask), /ask/);
  assert.ok(checkSchema("result", ask).length);
});

test("a receipt's key with half a character in it is refused: stored and looked up differently, it could never match", () => {
  const key = "half-\ud83d-key";
  const words = { title: "看Один眼", text: "этот" };
  assert.throws(() => parseResult({ outcome: "done", ask: [{ ...words, options: ["А", "Б"], key }] }), /ask/);
  assert.throws(() => parseResult({ outcome: "done", notice: [{ ...words, key }] }), /notice/);
  assert.throws(() => parseResult({ outcome: "done", later: [{ key, cancel: true }] }), /later/);
  const whole = { outcome: "done", notice: [{ ...words, key: "Один-😀" }] };
  assert.deepEqual(parseResult(whole), whole);
});

test("wire schemas agree with event and receipt boundaries", () => {
  for (const input of [
    { id: "one", type: "app.changed" },
    { id: " ", type: "app.changed", summary: null },
    { id: "one", type: "app.changed", source: "other" },
    { id: 7, type: "invalid" },
    { id: "one", type: "bad type" },
  ]) {
    let accepted = true;
    try {
      parseEvent(input);
    } catch {
      accepted = false;
    }
    assert.equal(checkSchema("event", input).length === 0, accepted);
  }
  for (const input of [
    { outcome: "done" },
    { outcome: "done", events: [{ id: "x", type: "app.changed" }] },
    { outcome: "unknown" },
    { outcome: "done", ask: [{ title: "选", text: "Содержание", options: ["Один"] }] },
    { outcome: "done", ask: [{ title: "选", text: "Содержание", options: ["Один", "Два"], recommend: 2 }] },
    { outcome: "done", later: [{ key: "k", at: "badZ", about: "Позже" }] },
  ]) {
    let accepted = true;
    try {
      parseResult(input);
    } catch {
      accepted = false;
    }
    assert.equal(checkSchema("result", input).length === 0, accepted);
  }
});

test("schema checks reject inherited names and incomplete tasks or question cards", () => {
  assert.ok(checkSchema("event", { id: "x", type: "one", constructor: "unexpected" }).length);
  assert.ok(checkSchema("job", { run: 1, token: "t", rule: {}, agent: {}, context: {} }).length);
  assert.ok(
    checkSchema("card", { id: 1, version: 1, kind: "ask", state: "open", title: "选", text: "Содержание", options: [] })
      .length,
  );
  assert.throws(() => checkSchema("constructor", {}));
});

test("published text limits count Unicode characters, including astral code points", () => {
  const event = { id: "x", type: "one", summary: "😀".repeat(200) };
  assert.deepEqual(checkSchema("event", event), []);
  assert.equal(parseEvent(event).summary, event.summary);
  assert.deepEqual(checkSchema("tell-source", { key: "unicode", text: "😀".repeat(20000) }), []);
  const receipt = { outcome: "done", summary: "😀".repeat(500) };
  assert.deepEqual(checkSchema("result", receipt), []);
  assert.equal(parseResult(receipt).summary, receipt.summary);
});

test("usage must be an object of finite nonnegative amounts", () => {
  for (const usage of [[1], { cost: -1 }, { cost: Infinity }, { input: NaN }]) {
    assert.throws(() => parseResult({ outcome: "done", usage }));
    assert.ok(checkSchema("result", { outcome: "done", usage }).length);
  }
});

test("timer timestamps are real calendar dates in the documented ISO format", () => {
  for (const at of ["2000Z", "2026-02-30T10:00:00Z", "2026-01-01T25:00:00Z"]) {
    const result = { outcome: "done", later: [{ key: "later", at, about: "Проверьте еще раз" }] };
    assert.throws(() => parseResult(result));
    assert.ok(checkSchema("result", result).length);
  }
  const result = {
    outcome: "done",
    later: [{ key: "later", at: "2028-02-29T10:00:00+08:00", about: "Проверьте еще раз" }],
  };
  assert.doesNotThrow(() => parseResult(result));
  assert.deepEqual(checkSchema("result", result), []);
});
