import test from "node:test";
import assert from "node:assert/strict";

import {
  dispatchChatPlaybackActions,
  filterMusicActions,
  waitForPlaybackQueue,
} from "../chat-playback-actions.ts";

test("filterMusicActions strips music actions when AI music actions are disabled", () => {
  assert.deepEqual(
    filterMusicActions(
      [
        { type: "play_music", url: "/music/theme.mp3" },
        { type: "expression", name: "smile" },
        { type: "stop_music" },
      ],
      false,
    ),
    [{ type: "expression", name: "smile" }],
  );
});

test("dispatchChatPlaybackActions forwards filtered actions and music handlers to the plugin runtime", async () => {
  const calls = [];
  const playMusic = async () => {};
  const stopMusic = () => {};

  await dispatchChatPlaybackActions({
    pluginRuntime: {
      dispatchActions: async (actions, handlers) => {
        calls.push({ actions, handlers });
      },
    },
    actions: [
      { type: "play_music", url: "/music/theme.mp3" },
      { type: "motion", group: "Idle", index: 0 },
    ],
    allowMusicActions: false,
    playMusic,
    stopMusic,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].actions, [{ type: "motion", group: "Idle", index: 0 }]);
  assert.equal(calls[0].handlers.playMusic, playMusic);
  assert.equal(calls[0].handlers.stopMusic, stopMusic);
});

test("waitForPlaybackQueue swallows queue failures after reporting them", async () => {
  const reported = [];

  await waitForPlaybackQueue(
    Promise.reject(new Error("queue exploded")),
    (error) => reported.push(String(error)),
  );

  assert.deepEqual(reported, ["Error: queue exploded"]);
});
