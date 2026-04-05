import test from "node:test";
import assert from "node:assert/strict";

import {
  createNextPlaybackVersion,
  isPlaybackVersionCurrent,
  shouldFocusRealtimeSession,
  shouldSpeakRealtimeMessage,
} from "../speech-runtime-utils.ts";

test("shouldSpeakRealtimeMessage ignores current-session assistant messages that are not push", () => {
  assert.equal(
    shouldSpeakRealtimeMessage(
      {
        id: "msg_1",
        sessionId: "session_active",
        role: "assistant",
        source: "chat",
      },
      "session_active",
    ),
    false,
  );
});

test("shouldSpeakRealtimeMessage still allows current-session push messages", () => {
  assert.equal(
    shouldSpeakRealtimeMessage(
      {
        id: "msg_2",
        sessionId: "session_active",
        role: "assistant",
        source: "push",
      },
      "session_active",
    ),
    true,
  );
});

test("shouldFocusRealtimeSession switches to a different session for push messages", () => {
  assert.equal(
    shouldFocusRealtimeSession(
      {
        id: "msg_push_1",
        sessionId: "session_push",
        role: "assistant",
        source: "push",
      },
      "session_active",
    ),
    true,
  );
});

test("shouldFocusRealtimeSession ignores push messages already in the current session", () => {
  assert.equal(
    shouldFocusRealtimeSession(
      {
        id: "msg_push_2",
        sessionId: "session_active",
        role: "assistant",
        source: "push",
      },
      "session_active",
    ),
    false,
  );
});

test("shouldFocusRealtimeSession ignores non-push messages", () => {
  assert.equal(
    shouldFocusRealtimeSession(
      {
        id: "msg_chat_1",
        sessionId: "session_push",
        role: "assistant",
        source: "chat",
      },
      "session_active",
    ),
    false,
  );
});

test("isPlaybackVersionCurrent invalidates older queued playback work after an interrupt bump", () => {
  const initialVersion = 1;
  const activeVersion = createNextPlaybackVersion(initialVersion);

  assert.equal(isPlaybackVersionCurrent(initialVersion, activeVersion), false);
  assert.equal(isPlaybackVersionCurrent(activeVersion, activeVersion), true);
});
