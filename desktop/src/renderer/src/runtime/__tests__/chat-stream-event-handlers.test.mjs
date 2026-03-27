import test from "node:test";
import assert from "node:assert/strict";

import { reduceChatStreamEvent } from "../chat-stream-event-handlers.ts";

test("reduceChatStreamEvent updates streaming preview text and subtitle on chunk events", () => {
  const nextState = reduceChatStreamEvent({
    event: {
      event: "chunk",
      data: {
        visibleText: "你好呀",
        rawText: "你好呀[wave]",
      },
    },
    streamingMessage: {
      id: "stream_1",
      sessionId: "session_1",
      text: "你",
      rawText: "你",
      createdAt: 1711111111,
    },
    subtitle: "你",
    actions: [{ type: "existing" }],
  });

  assert.deepEqual(nextState.streamingMessage, {
    id: "stream_1",
    sessionId: "session_1",
    text: "你好呀",
    rawText: "你好呀[wave]",
    createdAt: 1711111111,
  });
  assert.equal(nextState.subtitle, "你好呀");
  assert.deepEqual(nextState.actions, [{ type: "existing" }]);
});

test("reduceChatStreamEvent surfaces timeline units without mutating accumulated state", () => {
  const nextState = reduceChatStreamEvent({
    event: {
      event: "timeline",
      data: {
        unit: {
          i: 0,
          text: "第一句",
          directives: [{ type: "motion", group: "Idle", index: 0 }],
          audioUrl: "/audio/1.wav",
          contentType: "audio/wav",
        },
      },
    },
    streamingMessage: null,
    subtitle: "",
    actions: [],
  });

  assert.deepEqual(nextState.timelineUnit, {
    i: 0,
    text: "第一句",
    directives: [{ type: "motion", group: "Idle", index: 0 }],
    audioUrl: "/audio/1.wav",
    contentType: "audio/wav",
  });
  assert.equal(nextState.streamingMessage, null);
  assert.equal(nextState.subtitle, "");
  assert.deepEqual(nextState.actions, []);
});

test("reduceChatStreamEvent appends final actions and commits the final subtitle", () => {
  const nextState = reduceChatStreamEvent({
    event: {
      event: "final",
      data: {
        ok: true,
        messageId: "msg_1",
        userText: "你好",
        reply: "你好呀",
        actions: [{ type: "expression", name: "smile" }],
      },
    },
    streamingMessage: null,
    subtitle: "",
    actions: [{ type: "existing" }],
  });

  assert.equal(nextState.subtitle, "你好呀");
  assert.deepEqual(nextState.actions, [
    { type: "existing" },
    { type: "expression", name: "smile" },
  ]);
});

test("reduceChatStreamEvent exposes stream errors as plain messages", () => {
  const nextState = reduceChatStreamEvent({
    event: {
      event: "error",
      data: {
        error: "chat stream error",
      },
    },
    streamingMessage: null,
    subtitle: "",
    actions: [],
  });

  assert.equal(nextState.error, "chat stream error");
});
