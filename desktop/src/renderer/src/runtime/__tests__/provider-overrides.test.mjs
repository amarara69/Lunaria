import test from "node:test";
import assert from "node:assert/strict";

import { getProviderOverridesPayload } from "../provider-overrides.ts";

test("getProviderOverridesPayload flattens known provider fields onto chat payload root", () => {
  const provider = {
    id: "live2d-channel",
    fields: [
      { key: "bridgeUrl" },
      { key: "session" },
      { key: "ignored" },
    ],
  };

  const values = {
    "live2d-channel.bridgeUrl": "ws://127.0.0.1:18081",
    "live2d-channel.session": "live2d:direct:desktop-user",
    "live2d-channel.ignored": "noop",
  };

  assert.deepEqual(getProviderOverridesPayload(provider, values), {
    bridgeUrl: "ws://127.0.0.1:18081",
    session: "live2d:direct:desktop-user",
  });
});

test("getProviderOverridesPayload ignores blank or unknown override values", () => {
  const provider = {
    id: "bridge",
    fields: [
      { key: "bridgeUrl" },
      { key: "baseUrl" },
    ],
  };

  const values = {
    "bridge.bridgeUrl": "   ",
    "bridge.baseUrl": "http://127.0.0.1:8317/v1",
    "bridge.other": "x",
  };

  assert.deepEqual(getProviderOverridesPayload(provider, values), {
    baseUrl: "http://127.0.0.1:8317/v1",
  });
});

test("getProviderOverridesPayload can nest TTS-compatible overrides under a dedicated key", () => {
  const provider = {
    id: "openai-compatible",
    fields: [
      { key: "baseUrl" },
      { key: "model" },
      { key: "voice" },
      { key: "speed" },
    ],
  };

  const values = {
    "openai-compatible.baseUrl": "http://127.0.0.1:8001/v1",
    "openai-compatible.model": "tts-1",
    "openai-compatible.voice": "alloy",
    "openai-compatible.speed": "0.5",
  };

  assert.deepEqual(
    getProviderOverridesPayload(provider, values, { nestKey: "ttsOverrides" }),
    {
      ttsOverrides: {
        baseUrl: "http://127.0.0.1:8001/v1",
        model: "tts-1",
        voice: "alloy",
        speed: "0.5",
      },
    },
  );
});
