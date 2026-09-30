import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  flatten,
  findMatch,
  backoffSeconds,
  StateStore,
} from "../src/watcher.js";
import { loadConfig, DEFAULT_MATCHES } from "../src/config.js";

describe("Watcher Helpers", () => {
  test("flatten collapses arbitrary whitespace and newlines", () => {
    const text = "  Selected   model\n  is at\tcapacity. \n";
    assert.equal(flatten(text), "Selected model is at capacity.");
  });

  test("findMatch matches exact and wrapped banner text", () => {
    const patterns = [
      "Selected model is at capacity",
      "stream disconnected before completion: Our servers are currently overloaded",
    ];

    const normalTail =
      "Error occurred:\nSelected model is at capacity.\nPlease try a different model.";
    assert.equal(findMatch(normalTail, patterns), patterns[0]);

    const wrappedTail =
      "stream disconnected before completion:\n   Our servers are currently\n   overloaded. Please try again later.";
    assert.equal(findMatch(wrappedTail, patterns), patterns[1]);

    const cleanTail = "Agent is waiting for instructions: ready.";
    assert.equal(findMatch(cleanTail, patterns), null);
  });

  test("backoffSeconds calculates exponential wait with ceiling", () => {
    const minWait = 15;
    const maxWait = 60;

    assert.equal(backoffSeconds(0, minWait, maxWait), 15);
    assert.equal(backoffSeconds(1, minWait, maxWait), 30);
    assert.equal(backoffSeconds(2, minWait, maxWait), 60); // 15 * 4 = 60
    assert.equal(backoffSeconds(3, minWait, maxWait), 60); // capped at 60
    assert.equal(backoffSeconds(10, minWait, maxWait), 60);
  });
});

describe("StateStore", () => {
  test("persists and reloads target state from disk", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-retry-test-"));
    try {
      const store1 = new StateStore(tmpDir);
      const state1 = store1.get("w1:p1");
      state1.first_seen_at = 1000;
      state1.hit_count = 2;
      state1.next_retry_at = 1060;
      store1.set("w1:p1", state1);

      // Re-instantiate to simulate restart
      const store2 = new StateStore(tmpDir);
      const state2 = store2.get("w1:p1");
      assert.equal(state2.first_seen_at, 1000);
      assert.equal(state2.hit_count, 2);
      assert.equal(state2.next_retry_at, 1060);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Config Loader", () => {
  test("loads default configuration", () => {
    const config = loadConfig();
    assert.deepEqual(config.agents, ["codex"]);
    assert.deepEqual(config.matches, DEFAULT_MATCHES);
    assert.equal(config.prompt, "continue");
    assert.equal(config.minWait, 15);
    assert.equal(config.maxWait, 60);
    assert.equal(config.intervals.busy, 5);
    assert.equal(config.intervals.active, 10);
    assert.equal(config.intervals.idle, 60);
  });

  test("accepts programmatic overrides", () => {
    const config = loadConfig({
      prompt: "please retry",
      minWait: 20,
      agents: ["codex", "claude"],
    });
    assert.equal(config.prompt, "please retry");
    assert.equal(config.minWait, 20);
    assert.deepEqual(config.agents, ["codex", "claude"]);
  });
});
