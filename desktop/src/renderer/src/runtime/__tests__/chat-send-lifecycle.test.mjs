import test from "node:test";
import assert from "node:assert/strict";

import { buildOptimisticChatSendState } from "../chat-send-lifecycle.ts";

test("buildOptimisticChatSendState seeds optimistic system and user messages alongside streaming state", () => {
  const nextState = buildOptimisticChatSendState({
    sessionId: "session_1",
    text: "你好",
    systemNote: "截图已发送",
    attachments: [
      { type: "base64", data: "abc123", mediaType: "image/png" },
      { type: "url", data: "/files/voice.mp3", mediaType: "audio/mpeg" },
    ],
    nowMs: 1711111112000,
    makeMessageId: (role, index) => `${role}_${index}`,
    makeStreamingId: () => "stream_fixed",
  });

  assert.deepEqual(
    nextState.optimisticMessages,
    [
      {
        id: "system_0",
        sessionId: "session_1",
        role: "system",
        text: "截图已发送",
        attachments: [],
        source: "system",
        createdAt: 1711111112,
      },
      {
        id: "user_1",
        sessionId: "session_1",
        role: "user",
        text: "你好",
        attachments: [
          { mimeType: "image/png", data: "abc123", url: undefined },
          { mimeType: "audio/mpeg", data: undefined, url: "/files/voice.mp3" },
        ],
        source: "chat",
        createdAt: 1711111112,
      },
    ],
  );
  assert.deepEqual(nextState.streamingMessage, {
    id: "stream_fixed",
    sessionId: "session_1",
    text: "",
    rawText: "",
    createdAt: 1711111112,
  });
});

test("buildOptimisticChatSendState can skip the user bubble while still creating streaming state", () => {
  const nextState = buildOptimisticChatSendState({
    sessionId: "session_2",
    text: "后台继续处理",
    showUserBubble: false,
    nowMs: 1711111113000,
    makeMessageId: (role, index) => `${role}_${index}`,
    makeStreamingId: () => "stream_hidden_user",
  });

  assert.deepEqual(nextState.optimisticMessages, []);
  assert.deepEqual(nextState.streamingMessage, {
    id: "stream_hidden_user",
    sessionId: "session_2",
    text: "",
    rawText: "",
    createdAt: 1711111113,
  });
});
