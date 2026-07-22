import { test } from "bun:test";
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "./assertions.ts";
import { runOnce, type RunOnceDependencies } from "../src/cli/run-once.ts";

const NOW = Date.UTC(2026, 6, 20);
const DAY_MS = 24 * 60 * 60 * 1000;

function lifecycleDependencies(
  run: (from: number, to: number) => Promise<never[]>,
  onDestroy: () => void,
): RunOnceDependencies {
  return {
    now: () => NOW,
    createClient: () =>
      Promise.resolve({
        destroy: onDestroy,
      }),
    createPipeline: () => ({ run }),
  };
}

test("runOnce destroys its Telegram client exactly once after success", async () => {
  let destroyCount = 0;
  let receivedWindow: [number, number] | undefined;
  const dependencies = lifecycleDependencies(
    (from, to) => {
      receivedWindow = [from, to];
      return Promise.resolve([]);
    },
    () => {
      destroyCount += 1;
    },
  );

  await runOnce(dependencies);

  assertEquals(destroyCount, 1);
  assertEquals(receivedWindow, [NOW - 7 * DAY_MS, NOW - 5 * DAY_MS]);
});

test("runOnce destroys its Telegram client and propagates pipeline failure", async () => {
  const pipelineFailure = new Error("pipeline failed");
  let destroyCount = 0;
  const dependencies = lifecycleDependencies(
    () => Promise.reject(pipelineFailure),
    () => {
      destroyCount += 1;
    },
  );

  const rejection = await assertRejects(() => runOnce(dependencies));

  assertStrictEquals(rejection, pipelineFailure);
  assertEquals(destroyCount, 1);
});
