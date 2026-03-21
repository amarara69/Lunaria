import test from "node:test";
import assert from "node:assert/strict";

import { resolveProviderFieldState } from "../provider-field-state.ts";

function buildManifest(fieldsByProvider, ttsFieldsByProvider = {}) {
  return {
    model: {
      chat: {
        providers: Object.entries(fieldsByProvider).map(([providerId, fields]) => ({
          id: providerId,
          fields: Object.entries(fields).map(([key, value]) => ({
            key,
            value,
          })),
        })),
        tts: {
          providers: Object.entries(ttsFieldsByProvider).map(([providerId, fields]) => ({
            id: providerId,
            fields: Object.entries(fields).map(([key, value]) => ({
              key,
              value,
            })),
          })),
        },
      },
    },
  };
}

test("resolveProviderFieldState seeds provider fields from manifest values", () => {
  const manifest = buildManifest({
    "live2d-channel": {
      bridgeUrl: "ws://127.0.0.1:18081",
      agent: "main",
    },
  });

  assert.deepEqual(
    resolveProviderFieldState({
      manifest,
      previousValues: {},
      previousManifestValues: {},
    }),
    {
      values: {
        "live2d-channel.bridgeUrl": "ws://127.0.0.1:18081",
        "live2d-channel.agent": "main",
      },
      manifestValues: {
        "live2d-channel.bridgeUrl": "ws://127.0.0.1:18081",
        "live2d-channel.agent": "main",
      },
    },
  );
});

test("resolveProviderFieldState resets stale cached values when no manifest snapshot exists yet", () => {
  const manifest = buildManifest({
    "live2d-channel": {
      bridgeUrl: "ws://127.0.0.1:18789",
    },
  });

  assert.deepEqual(
    resolveProviderFieldState({
      manifest,
      previousValues: {
        "live2d-channel.bridgeUrl": "ws://127.0.0.1:18081",
      },
      previousManifestValues: {},
    }),
    {
      values: {
        "live2d-channel.bridgeUrl": "ws://127.0.0.1:18789",
      },
      manifestValues: {
        "live2d-channel.bridgeUrl": "ws://127.0.0.1:18789",
      },
    },
  );
});

test("resolveProviderFieldState updates values when they still match the old manifest snapshot", () => {
  const manifest = buildManifest({
    "live2d-channel": {
      bridgeUrl: "ws://127.0.0.1:18789",
    },
  });

  assert.deepEqual(
    resolveProviderFieldState({
      manifest,
      previousValues: {
        "live2d-channel.bridgeUrl": "ws://127.0.0.1:18081",
      },
      previousManifestValues: {
        "live2d-channel.bridgeUrl": "ws://127.0.0.1:18081",
      },
    }),
    {
      values: {
        "live2d-channel.bridgeUrl": "ws://127.0.0.1:18789",
      },
      manifestValues: {
        "live2d-channel.bridgeUrl": "ws://127.0.0.1:18789",
      },
    },
  );
});

test("resolveProviderFieldState preserves explicit user overrides", () => {
  const manifest = buildManifest({
    "live2d-channel": {
      bridgeUrl: "ws://127.0.0.1:18789",
      agent: "main",
    },
  });

  assert.deepEqual(
    resolveProviderFieldState({
      manifest,
      previousValues: {
        "live2d-channel.bridgeUrl": "ws://10.0.0.5:19000",
        "live2d-channel.agent": "desktop-user",
      },
      previousManifestValues: {
        "live2d-channel.bridgeUrl": "ws://127.0.0.1:18081",
        "live2d-channel.agent": "main",
      },
    }),
    {
      values: {
        "live2d-channel.bridgeUrl": "ws://10.0.0.5:19000",
        "live2d-channel.agent": "desktop-user",
      },
      manifestValues: {
        "live2d-channel.bridgeUrl": "ws://127.0.0.1:18789",
        "live2d-channel.agent": "main",
      },
    },
  );
});

test("resolveProviderFieldState includes TTS provider fields alongside chat provider fields", () => {
  const manifest = buildManifest(
    {
      "live2d-channel": {
        bridgeUrl: "ws://127.0.0.1:18081",
      },
    },
    {
      "openai-compatible": {
        baseUrl: "http://127.0.0.1:8001/v1",
        model: "tts-1",
        voice: "alloy",
      },
    },
  );

  assert.deepEqual(
    resolveProviderFieldState({
      manifest,
      previousValues: {},
      previousManifestValues: {},
    }),
    {
      values: {
        "live2d-channel.bridgeUrl": "ws://127.0.0.1:18081",
        "openai-compatible.baseUrl": "http://127.0.0.1:8001/v1",
        "openai-compatible.model": "tts-1",
        "openai-compatible.voice": "alloy",
      },
      manifestValues: {
        "live2d-channel.bridgeUrl": "ws://127.0.0.1:18081",
        "openai-compatible.baseUrl": "http://127.0.0.1:8001/v1",
        "openai-compatible.model": "tts-1",
        "openai-compatible.voice": "alloy",
      },
    },
  );
});
