import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import i18n from "@/i18n";
import { toaster } from "@/shared/ui/toaster";
import { useConfig } from "@/context/character-config-context";
import { ModelInfo, useLive2DConfig } from "@/context/live2d-config-context";
import { useMode } from "@/context/mode-context";
import {
  attachmentToChatInput,
  ComposerAttachment,
  createComposerAttachmentId,
  dataUrlToFile,
  dataUrlToComposerAttachment,
  fileToComposerAttachment,
  getQuickActionLabel,
  RuntimeRect,
  useAppStore,
} from "@/domains/renderer-store";
import { AiStateEnum, useVoiceStore } from "@/domains/voice/store";
import { createTempFileComposerAttachment } from "@/runtime/composer-attachment-utils.ts";
import { shouldRunAutomationRule } from "@/runtime/automation-utils.ts";
import { resolveAssistantDisplayName } from "@/runtime/assistant-display-utils.ts";
import {
  beginBackendConnectionSession,
  shouldApplyBackendConnectionUpdate,
  shouldPreferConfiguredBackendUrl,
} from "@/runtime/backend-connection-utils.ts";
import { getConnectionStateAfterChatError } from "@/runtime/chat-runtime-utils.ts";
import { resolveFocusCenterConfig } from "@/runtime/focus-center-utils.ts";
import { getManifestHydrationState } from "@/runtime/manifest-hydration-utils.ts";
import { resolveProviderFieldState } from "@/runtime/provider-field-state.ts";
import { getProviderOverridesPayload } from "@/runtime/provider-overrides.ts";
import {
  shouldUseGlobalCursorTracking,
  toRendererPointerFromScreenPoint,
} from "@/runtime/global-cursor-utils.ts";
import {
  createRealtimeLipSyncCleanup,
  getActiveLive2DModel,
  getLipSyncPlaybackMode,
} from "@/runtime/live2d-audio-utils.ts";
import {
  createNextPlaybackVersion,
  isPlaybackVersionCurrent,
  shouldSpeakRealtimeMessage,
} from "@/runtime/speech-runtime-utils.ts";
import {
  applyFocusCenter,
  applyPersistentToggleState,
  applyStageDirectives,
  getModelBounds,
  playExpression,
  playMotion,
  setTrackedPointerPosition,
} from "@/runtime/live2d-bridge";
import { audioManager } from "@/utils/audio-manager";
import {
  resolvePetAnchorUpdate,
  shouldUpdatePetAnchor,
} from "@/runtime/pet-shell-interaction-utils.ts";
import { createPluginRuntime } from "@/runtime/plugin-runtime";
import {
  buildBackendUrl,
  ChatAttachmentInput,
  ChatStreamEvent,
  LunariaAttachment,
  LunariaManifest,
  LunariaMessage,
  createSession,
  fetchManifest,
  fetchMessages,
  fetchSessions,
  normalizeBaseUrl,
  openEventsStream,
  requestTts,
  selectSession,
  streamChat,
} from "@/platform/backend/openclaw-api";

interface RendererCommandContextValue {
  reconnect: () => Promise<void>;
  createNewSession: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  sendComposerMessage: () => Promise<void>;
  interrupt: () => void;
  switchModel: (modelId: string) => Promise<void>;
  setProviderFieldValue: (providerId: string, fieldKey: string, value: string) => void;
  addFiles: (files: FileList | File[]) => Promise<void>;
  addClipboardItems: (items: DataTransferItemList | DataTransferItem[]) => Promise<void>;
  capturePrimaryScreenAttachment: () => Promise<void>;
  startScreenshotSelection: () => Promise<void>;
  closeScreenshotSelection: () => void;
  addCaptureDataUrl: (dataUrl: string, filename?: string) => Promise<void>;
  createPendingCaptureAttachment: (filename?: string) => string;
  resolvePendingCaptureAttachment: (attachmentId: string, payload: string | {
    fileUrl: string;
    cleanupToken: string;
    mimeType: string;
  }, filename?: string) => void;
  failPendingCaptureAttachment: (attachmentId: string) => void;
  executeQuickAction: (action: Record<string, unknown>) => Promise<void>;
  executeMotion: (group: string, index?: number) => Promise<void>;
  executeExpression: (name: string) => Promise<void>;
  refreshPlugins: () => Promise<void>;
  setBackgroundFromFile: (mode: "window" | "pet", file: File) => Promise<void>;
  clearBackground: (mode: "window" | "pet") => void;
  runAutomationProactive: (reason?: "manual" | "scheduled") => Promise<void>;
  runAutomationScreenshot: (reason?: "manual" | "scheduled") => Promise<void>;
  stopAutomationMusic: () => Promise<void>;
}

const RendererCommandContext = createContext<RendererCommandContextValue | null>(null);

function mapManifestToModelInfo(
  manifest: LunariaManifest,
  backendUrl: string,
): ModelInfo {
  const expressions = manifest.model.expressions || [];
  const defaultEmotion = expressions.find((expression) => {
    const name = String(expression.name || "").trim().toLowerCase();
    return ["default", "normal", "neutral", "idle", "base", "standard"].includes(name);
  })?.name;

  return {
    name: manifest.model.name,
    url: buildBackendUrl(backendUrl, manifest.model.modelJson),
    kScale: 0.5,
    initialXshift: 0,
    initialYshift: 0,
    idleMotionGroupName: "Idle",
    defaultEmotion,
    emotionMap: Object.fromEntries(
      expressions.map((expression) => [expression.name, expression.name]),
    ),
    lipSyncParamId: manifest.model.lipSyncParamId || "ParamMouthOpenY",
    pointerInteractive: true,
    scrollToResize: true,
  };
}

function resolveAttachmentUrl(attachment: LunariaAttachment): string {
  const mimeType = attachment.mimeType || "application/octet-stream";
  if (attachment.url) {
    return attachment.url;
  }
  if (attachment.data) {
    return attachment.data.startsWith("data:")
      ? attachment.data
      : `data:${mimeType};base64,${attachment.data}`;
  }
  return "";
}

function findFirstAudioAttachmentUrl(backendUrl: string, message: LunariaMessage): string {
  for (const attachment of message.attachments || []) {
    const mimeType = String(attachment.mimeType || "").toLowerCase();
    const kind = String(attachment.kind || "").toLowerCase();
    if (!mimeType.startsWith("audio/") && kind !== "audio") {
      continue;
    }

    const url = resolveAttachmentUrl(attachment);
    if (!url) {
      continue;
    }
    return /^https?:\/\//i.test(url) || url.startsWith("data:")
      ? url
      : buildBackendUrl(backendUrl, url);
  }
  return "";
}

function buildPetAnchor(
  bounds: RuntimeRect | null,
  workArea: { x: number; y: number; width: number; height: number },
  virtualBounds: { x: number; y: number; width: number; height: number },
  expanded: boolean,
): { x: number; y: number } {
  const cardWidth = expanded ? 420 : 340;
  const cardHeight = expanded ? 540 : 380;
  const relativeWorkArea = {
    x: workArea.x - virtualBounds.x,
    y: workArea.y - virtualBounds.y,
    width: workArea.width,
    height: workArea.height,
  };

  if (!bounds) {
    return {
      x: Math.max(16, relativeWorkArea.x + relativeWorkArea.width - cardWidth - 24),
      y: Math.max(16, relativeWorkArea.y + relativeWorkArea.height - cardHeight - 32),
    };
  }

  const rightCandidate = bounds.right + 20;
  const leftCandidate = bounds.left - cardWidth - 20;
  const maxX = relativeWorkArea.x + relativeWorkArea.width - cardWidth - 16;
  const minX = relativeWorkArea.x + 16;
  let x = clamp(rightCandidate, minX, maxX);
  if (rightCandidate > maxX && leftCandidate >= minX) {
    x = leftCandidate;
  }

  const y = clamp(
    bounds.bottom - cardHeight + 60,
    relativeWorkArea.y + 16,
    relativeWorkArea.y + relativeWorkArea.height - cardHeight - 16,
  );

  return { x, y };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function createOptimisticMessage(
  sessionId: string,
  role: "user" | "assistant" | "system",
  text: string,
  attachments: LunariaAttachment[] = [],
  source = "chat",
): LunariaMessage {
  return {
    id: `${role}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    role,
    text,
    attachments,
    source,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

function filterMusicActions(actions: unknown[], allowMusicActions: boolean): unknown[] {
  if (allowMusicActions) {
    return Array.isArray(actions) ? actions : [];
  }

  return (Array.isArray(actions) ? actions : []).filter((action) => {
    const type = String((action as Record<string, unknown>)?.type || "").trim().toLowerCase();
    return type !== "play_music" && type !== "stop_music";
  });
}

function normalizePluginAttachments(
  attachments: Array<{
    preview?: string;
    data?: string;
    mediaType?: string;
    filename?: string;
    type?: "base64" | "url";
  }>,
): ComposerAttachment[] {
  return (attachments || [])
    .map((attachment) => {
      if (attachment.preview) {
        return dataUrlToComposerAttachment(
          attachment.preview,
          attachment.filename || "plugin-attachment",
        );
      }

      if (attachment.data && attachment.mediaType) {
        return dataUrlToComposerAttachment(
          `data:${attachment.mediaType};base64,${attachment.data}`,
          attachment.filename || "plugin-attachment",
        );
      }

      return null;
    })
    .filter((item): item is ComposerAttachment => Boolean(item));
}

export function RendererCommandProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const backendUrl = useAppStore((state) => state.backendUrl);
  const manifest = useAppStore((state) => state.manifest);
  const focusCenterByModel = useAppStore((state) => state.focusCenterByModel);
  const currentModelBounds = useAppStore((state) => state.currentModelBounds);
  const petAnchor = useAppStore((state) => state.petAnchor);
  const petAnchorLocked = useAppStore((state) => state.petAnchorLocked);
  const petExpanded = useAppStore((state) => state.petExpanded);
  const currentSessionId = useAppStore((state) => state.currentSessionId);
  const { modelInfo, setModelInfo } = useLive2DConfig();
  const { confName, setConfName, setConfUid, setConfigFiles } = useConfig();
  const { mode } = useMode();
  const setAiState = useVoiceStore((state) => state.setAiState);
  const setForceIgnoreMouse = useVoiceStore((state) => state.setForceIgnoreMouse);

  const normalizedBackendUrl = normalizeBaseUrl(backendUrl);
  const currentAbortRef = useRef<AbortController | null>(null);
  const eventsCleanupRef = useRef<(() => void) | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const backendConnectionStoreRef = useRef({ activeSessionId: 0 });
  const playbackQueueRef = useRef(Promise.resolve());
  const playbackVersionRef = useRef(0);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const musicAudioRef = useRef<HTMLAudioElement | null>(null);
  const currentSessionRef = useRef<string | null>(null);
  const pluginRuntimeRef = useRef<ReturnType<typeof createPluginRuntime> | null>(null);
  const streamingActionsRef = useRef<unknown[]>([]);
  const sendPayloadRef = useRef<((payload: {
    text: string;
    attachments?: ChatAttachmentInput[];
    clearComposer?: boolean;
    throwOnError?: boolean;
    messageSource?: "chat" | "tool" | "automation";
    allowMusicActions?: boolean;
    showUserBubble?: boolean;
    systemNote?: string;
    assistantMeta?: string;
  }) => Promise<void>) | null>(null);
  const [petOverlayBounds, setPetOverlayBounds] = useState<{
    workArea: { x: number; y: number; width: number; height: number };
    virtualBounds: { x: number; y: number; width: number; height: number };
  } | null>(null);
  const currentModelId = manifest?.selectedModelId || manifest?.model.id || "";
  const assistantDisplayName = resolveAssistantDisplayName({
    configName: confName,
    manifestName: manifest?.model.name,
  });
  const currentFocusCenter = resolveFocusCenterConfig({
    manifest,
    focusCenterByModel,
    modelId: currentModelId,
  });

  useEffect(() => {
    currentSessionRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    let disposed = false;

    const hydrateConfiguredBackendUrl = async () => {
      try {
        const configuredBackendUrl = String(
          await window.api?.getConfiguredBackendUrl?.() || "",
        ).trim();
        if (disposed) {
          return;
        }

        const currentBackendUrl = useAppStore.getState().backendUrl;
        if (!shouldPreferConfiguredBackendUrl({
          currentUrl: currentBackendUrl,
          configuredUrl: configuredBackendUrl,
        })) {
          return;
        }

        useAppStore.getState().setBackendUrl(configuredBackendUrl);
      } catch (error) {
        console.warn("Failed to hydrate configured backend URL:", error);
      }
    };

    void hydrateConfiguredBackendUrl();

    return () => {
      disposed = true;
    };
  }, []);

  const createConnectionUpdateGuard = useCallback(
    (sessionId: number, isDisposed: () => boolean) => () => shouldApplyBackendConnectionUpdate({
      sessionId,
      store: backendConnectionStoreRef.current,
      isDisposed: isDisposed(),
    }),
    [],
  );

  const stopCurrentAudio = useCallback(() => {
    audioManager.stopCurrentAudioAndLipSync();
    currentAudioRef.current = null;
  }, []);

  const playMusic = useCallback(async ({ url }: { url?: string; trackId?: string }) => {
    const automationMusic = useAppStore.getState().automation.music;
    const targetUrl = String(url || automationMusic.defaultUrl || "").trim();
    if (!targetUrl) {
      useAppStore.getState().appendAutomationLog("AI 请求播放音乐，但未配置音乐 URL", "warn");
      return;
    }
    if (musicAudioRef.current) {
      musicAudioRef.current.pause();
      musicAudioRef.current.src = "";
    }
    const audio = new Audio(
      /^https?:\/\//i.test(targetUrl) || targetUrl.startsWith("data:")
        ? targetUrl
        : buildBackendUrl(normalizedBackendUrl, targetUrl),
    );
    audio.loop = !!automationMusic.loop;
    audio.volume = Number(automationMusic.volume ?? 0.35);
    musicAudioRef.current = audio;
    await audio.play().catch((error) => {
      useAppStore.getState().appendAutomationLog(`播放音乐失败：${error}`, "error");
      toaster.create({
        title: `音乐播放失败: ${error}`,
        type: "error",
        duration: 2400,
      });
    });
    useAppStore.getState().appendAutomationLog(`已播放音乐：${targetUrl}`);
  }, [normalizedBackendUrl]);

  const stopMusic = useCallback(() => {
    if (musicAudioRef.current) {
      musicAudioRef.current.pause();
      musicAudioRef.current.src = "";
      musicAudioRef.current = null;
    }
    useAppStore.getState().appendAutomationLog("已停止自动化音乐");
  }, []);

  const getCurrentTtsOverrides = useCallback(() => {
    const state = useAppStore.getState();
    const ttsProviderConfig = state.manifest?.model.chat.tts.providers.find((item) => item.id === state.ttsProvider) || null;
    return getProviderOverridesPayload(ttsProviderConfig, state.providerFieldValues, { nestKey: "ttsOverrides" });
  }, []);

  const enqueueSpeech = useCallback((payload: {
    text?: string;
    audioUrl?: string;
    audioMimeType?: string;
    directives?: unknown[];
    mode?: "chat" | "push";
  }) => {
    const queueVersion = playbackVersionRef.current;
    playbackQueueRef.current = playbackQueueRef.current
      .then(async () => {
        if (!isPlaybackVersionCurrent(queueVersion, playbackVersionRef.current)) {
          return;
        }
        applyStageDirectives(payload.directives || []);

        let targetUrl = String(payload.audioUrl || "").trim();
        let targetMimeType = String(payload.audioMimeType || "").trim();
        let shouldRevoke = false;

        if (!targetUrl && payload.text && useAppStore.getState().ttsEnabled) {
          const state = useAppStore.getState();
          const blob = await requestTts(normalizedBackendUrl, {
            text: payload.text,
            provider: state.ttsProvider,
            mode: payload.mode || "chat",
            ...getCurrentTtsOverrides(),
          });
          if (!isPlaybackVersionCurrent(queueVersion, playbackVersionRef.current)) {
            return;
          }
          targetUrl = URL.createObjectURL(blob);
          targetMimeType = blob.type || targetMimeType;
          shouldRevoke = true;
        }

        if (!targetUrl) {
          return;
        }

        await new Promise<void>((resolve) => {
          if (!isPlaybackVersionCurrent(queueVersion, playbackVersionRef.current)) {
            resolve();
            return;
          }
          stopCurrentAudio();
          const model = getActiveLive2DModel();
          const audio = new Audio(
            /^https?:\/\//i.test(targetUrl) || targetUrl.startsWith("blob:") || targetUrl.startsWith("data:")
              ? targetUrl
              : buildBackendUrl(normalizedBackendUrl, targetUrl),
          );
          audio.crossOrigin = "anonymous";
          currentAudioRef.current = audio;
          let lipSyncCleanup: (() => void) | null = null;
          let finished = false;
          const finish = () => {
            if (finished) {
              return;
            }
            finished = true;
            if (shouldRevoke) {
              URL.revokeObjectURL(targetUrl);
            }
            if (currentAudioRef.current === audio) {
              currentAudioRef.current = null;
            }
            audioManager.clearCurrentAudio(audio);
            resolve();
          };

          audioManager.setCurrentAudio(audio, model, () => {
            if (lipSyncCleanup) {
              lipSyncCleanup();
              lipSyncCleanup = null;
            }
            if (model) {
              model._externalLipSyncValue = null;
            }
          });

          audio.addEventListener("ended", finish, { once: true });
          audio.addEventListener("error", finish, { once: true });
          void audio.play()
            .then(() => {
              if (!isPlaybackVersionCurrent(queueVersion, playbackVersionRef.current)) {
                finish();
                return;
              }

              const lipSyncMode = getLipSyncPlaybackMode({
                audioMimeType: targetMimeType,
                audioSource: targetUrl,
              });
              if (model && lipSyncMode === "wav-handler" && model._wavFileHandler) {
                model._wavFileHandler.start(targetUrl);
              } else if (model && lipSyncMode === "realtime") {
                lipSyncCleanup = createRealtimeLipSyncCleanup(audio, model);
              }
            })
            .catch(() => finish());
        });
      })
      .catch((error) => {
        console.warn("Speech queue failed:", error);
      });
  }, [getCurrentTtsOverrides, normalizedBackendUrl, stopCurrentAudio]);

  const appendLocalAssistantMessage = useCallback((
    text: string,
    attachments: ComposerAttachment[] = [],
  ) => {
    const state = useAppStore.getState();
    const sessionId = state.currentSessionId;
    if (!sessionId) {
      return;
    }

    const message = createOptimisticMessage(
      sessionId,
      "assistant",
      text,
      attachments.map((attachment) => ({
        kind: attachment.kind,
        mimeType: attachment.mimeType,
        filename: attachment.filename,
        data: attachment.data,
      })),
      "plugin",
    );
    state.appendMessageForSession(sessionId, message);
  }, []);

  const sendPayload = useCallback(async (payload: {
    text: string;
    attachments?: ChatAttachmentInput[];
    clearComposer?: boolean;
    messageSource?: string;
    allowMusicActions?: boolean;
    throwOnError?: boolean;
    showUserBubble?: boolean;
    systemNote?: string;
    assistantMeta?: string;
  }) => {
    const state = useAppStore.getState();
    const activeManifest = state.manifest;
    if (!activeManifest) {
      return;
    }

    let sessionId = state.currentSessionId;
    if (!sessionId) {
      const created = await createSession(normalizedBackendUrl);
      sessionId = created.id;
      state.setSessions([created, ...state.sessions]);
      state.setCurrentSessionId(created.id);
    }

    const provider = activeManifest.model.chat.providers.find((item) => item.id === state.currentProviderId)
      || activeManifest.model.chat.providers[0]
      || null;
    const providerId = provider?.id || activeManifest.model.chat.defaultProviderId;

    if (payload.clearComposer !== false) {
      state.clearComposer();
    }

    if (payload.systemNote) {
      state.appendMessageForSession(sessionId, createOptimisticMessage(
        sessionId,
        "system",
        payload.systemNote,
        [],
        "system",
      ));
    }

    if (payload.showUserBubble !== false) {
      const optimisticUser = createOptimisticMessage(
        sessionId,
        "user",
        payload.text,
        (payload.attachments || []).map((attachment) => ({
          mimeType: attachment.mediaType,
          data: attachment.type === "base64" ? attachment.data : undefined,
          url: attachment.type === "url" ? attachment.data : undefined,
        })),
      );
      state.appendMessageForSession(sessionId, optimisticUser);
    }
    state.setStreamingMessage({
      id: `stream_${Date.now()}`,
      sessionId,
      text: "",
      rawText: "",
    });
    state.setConnectionState("connecting");
    state.setSubtitle("");
    setAiState(AiStateEnum.THINKING_SPEAKING);
    streamingActionsRef.current = [];

    const abortController = new AbortController();
    currentAbortRef.current = abortController;

    try {
      await streamChat(
        normalizedBackendUrl,
        {
          sessionId,
          modelId: activeManifest.selectedModelId,
          providerId,
          text: payload.text,
          attachments: payload.attachments,
          ttsEnabled: state.ttsEnabled,
          ttsProvider: state.ttsProvider,
          assistantMeta: payload.assistantMeta,
          messageSource: payload.messageSource || "chat",
          ...getProviderOverridesPayload(provider, state.providerFieldValues),
          ...getCurrentTtsOverrides(),
        },
        {
          signal: abortController.signal,
          onEvent: (event: ChatStreamEvent) => {
            if (event.event === "chunk") {
              useAppStore.setState((current) => ({
                streamingMessage: current.streamingMessage
                  ? {
                    ...current.streamingMessage,
                    text: event.data.visibleText || current.streamingMessage.text,
                    rawText: event.data.rawText || current.streamingMessage.rawText,
                  }
                  : current.streamingMessage,
                subtitle: event.data.visibleText || current.subtitle,
              }));
              return;
            }

            if (event.event === "timeline") {
              const unit = event.data.unit;
              enqueueSpeech({
                text: unit.text || "",
                audioUrl: unit.audioUrl
                  ? buildBackendUrl(normalizedBackendUrl, unit.audioUrl)
                  : "",
                audioMimeType: unit.contentType || "",
                directives: unit.directives || [],
                mode: "chat",
              });
              return;
            }

            if (event.event === "action") {
              streamingActionsRef.current = [
                ...streamingActionsRef.current,
                ...(event.data.actions || []),
              ];
              return;
            }

            if (event.event === "final") {
              streamingActionsRef.current = [
                ...streamingActionsRef.current,
                ...(event.data.actions || []),
              ];
              useAppStore.getState().setSubtitle(event.data.reply || "");
              return;
            }

            if (event.event === "error") {
              throw new Error(event.data.error || "chat stream error");
            }
          },
        },
      );

      const nextMessages = await fetchMessages(normalizedBackendUrl, sessionId);
      useAppStore.getState().setMessagesForSession(sessionId, nextMessages);
      useAppStore.getState().setStreamingMessage(null);
      useAppStore.getState().setConnectionState("open");
      const refreshed = await fetchSessions(normalizedBackendUrl);
      useAppStore.getState().setSessions(refreshed.sessions || []);
      await pluginRuntimeRef.current?.dispatchActions(filterMusicActions(
        streamingActionsRef.current,
        payload.allowMusicActions ?? true,
      ), {
        playMusic,
        stopMusic,
      });
      streamingActionsRef.current = [];
      await playbackQueueRef.current.catch((error) => {
        console.warn("Speech queue failed while finishing chat:", error);
      });
      setAiState(AiStateEnum.IDLE);
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") {
        toaster.create({
          title: `聊天失败: ${error}`,
          type: "error",
          duration: 2800,
        });
        setAiState(AiStateEnum.IDLE);
      }
      useAppStore.getState().setConnectionState(
        getConnectionStateAfterChatError(error as Error | { name?: string } | null | undefined),
      );
      useAppStore.getState().setStreamingMessage(null);
      if (payload.throwOnError) {
        throw error;
      }
    } finally {
      currentAbortRef.current = null;
    }
  }, [enqueueSpeech, getCurrentTtsOverrides, normalizedBackendUrl, playMusic, setAiState, stopMusic]);

  useEffect(() => {
    sendPayloadRef.current = sendPayload;
  }, [assistantDisplayName, sendPayload]);

  if (!pluginRuntimeRef.current) {
    pluginRuntimeRef.current = createPluginRuntime({
      listPlugins: async () => {
        if (!window.api?.listPlugins) {
          return { items: [] };
        }
        const payload = await window.api.listPlugins();
        return { items: payload.items };
      },
      sendToAI: async (payload) => {
        await sendPayloadRef.current?.({
          text: payload.text || "",
          attachments: payload.attachments || [],
          clearComposer: false,
          messageSource: "tool",
        });
      },
      sendToUser: (text, attachments) => {
        appendLocalAssistantMessage(text, normalizePluginAttachments(attachments || []));
      },
      capturePrimaryScreen: async () => window.api?.capturePrimaryScreen?.() || null,
      onLog: (message) => useAppStore.getState().appendPluginLog(message),
    });
  }

  const refreshPlugins = useCallback(async () => {
    useAppStore.getState().setPluginLoadState("loading");
    try {
      const items = await pluginRuntimeRef.current?.refreshCatalog();
      useAppStore.getState().setPlugins((items || []) as any);
      useAppStore.getState().setPluginLoadState("ready");
    } catch (error) {
      useAppStore.getState().setPluginLoadState("error");
      useAppStore.getState().appendPluginLog(`Plugin refresh failed: ${error}`);
    }
  }, []);

  const loadSession = useCallback(async (
    sessionId: string,
    options?: { shouldApply?: () => boolean },
  ) => {
    if (!sessionId) {
      return;
    }
    await selectSession(normalizedBackendUrl, sessionId);
    if (options?.shouldApply && !options.shouldApply()) {
      return;
    }
    const messages = await fetchMessages(normalizedBackendUrl, sessionId);
    if (options?.shouldApply && !options.shouldApply()) {
      return;
    }
    useAppStore.getState().setCurrentSessionId(sessionId);
    useAppStore.getState().setMessagesForSession(sessionId, messages);
  }, [normalizedBackendUrl]);

  const reconnect = useCallback(async (
    sessionId?: number,
    isDisposed: () => boolean = () => false,
  ) => {
    const connectionSessionId = typeof sessionId === "number"
      ? sessionId
      : beginBackendConnectionSession(backendConnectionStoreRef.current);
    const shouldApply = createConnectionUpdateGuard(connectionSessionId, isDisposed);

    if (!shouldApply()) {
      return;
    }

    setAiState(AiStateEnum.LOADING);
    useAppStore.getState().setConnectionState("connecting");
    try {
      const nextManifest = await fetchManifest(normalizedBackendUrl);
      if (!shouldApply()) {
        return;
      }
      const nextProviderFieldState = resolveProviderFieldState({
        manifest: nextManifest,
        previousValues: useAppStore.getState().providerFieldValues,
        previousManifestValues: useAppStore.getState().providerFieldManifestValues,
      });
      useAppStore.getState().setProviderFieldValues(nextProviderFieldState.values);
      useAppStore.getState().setProviderFieldManifestValues(nextProviderFieldState.manifestValues);
      useAppStore.getState().hydrateManifest(nextManifest);

      let sessionsPayload = await fetchSessions(normalizedBackendUrl);
      if (!shouldApply()) {
        return;
      }
      if (!(sessionsPayload.sessions || []).length) {
        await createSession(normalizedBackendUrl);
        if (!shouldApply()) {
          return;
        }
        sessionsPayload = await fetchSessions(normalizedBackendUrl);
        if (!shouldApply()) {
          return;
        }
      }

      useAppStore.getState().setSessions(sessionsPayload.sessions || []);
      const targetSessionId = useAppStore.getState().currentSessionId
        && sessionsPayload.sessions.some((session) => session.id === useAppStore.getState().currentSessionId)
        ? useAppStore.getState().currentSessionId
        : sessionsPayload.currentId || sessionsPayload.sessions?.[0]?.id || null;

      if (targetSessionId) {
        await loadSession(targetSessionId, { shouldApply });
      }

      if (!shouldApply()) {
        return;
      }

      await refreshPlugins();
      if (!shouldApply()) {
        return;
      }
      useAppStore.getState().setConnectionState("open");
      setAiState(AiStateEnum.IDLE);
    } catch (error) {
      if (!shouldApply()) {
        return;
      }
      useAppStore.getState().setConnectionState("error");
      toaster.create({
        title: `连接后端失败: ${error}`,
        type: "error",
        duration: 3200,
      });
    }
  }, [createConnectionUpdateGuard, loadSession, normalizedBackendUrl, refreshPlugins, setAiState]);

  const startEventsStream = useCallback((
    sessionId?: number,
    isDisposed: () => boolean = () => false,
  ) => {
    const connectionSessionId = typeof sessionId === "number"
      ? sessionId
      : beginBackendConnectionSession(backendConnectionStoreRef.current);
    const shouldApply = createConnectionUpdateGuard(connectionSessionId, isDisposed);

    if (eventsCleanupRef.current) {
      eventsCleanupRef.current();
      eventsCleanupRef.current = null;
    }

    eventsCleanupRef.current = openEventsStream(normalizedBackendUrl, {
      since: useAppStore.getState().lastEventSeq,
      onOpen: () => {
        if (!shouldApply()) {
          return;
        }
        reconnectAttemptRef.current = 0;
        useAppStore.getState().setConnectionState("open");
      },
      onError: () => {
        if (!shouldApply()) {
          return;
        }
        useAppStore.getState().setConnectionState("error");
        if (reconnectTimerRef.current) {
          window.clearTimeout(reconnectTimerRef.current);
        }
        const delay = Math.min(15000, 1000 * 2 ** reconnectAttemptRef.current);
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = window.setTimeout(() => {
          if (!shouldApply()) {
            return;
          }
          startEventsStream(connectionSessionId, isDisposed);
        }, delay);
      },
      onEvent: async (event) => {
        if (!shouldApply()) {
          return;
        }
        useAppStore.getState().setLastEventSeq(Number(event.seq || 0));
        if (event.type !== "message.created") {
          return;
        }

        const incoming = event.payload?.message as LunariaMessage | undefined;
        if (!incoming?.id || !incoming.sessionId) {
          return;
        }

        useAppStore.getState().upsertMessageForSession(incoming.sessionId, incoming);

        if (incoming.sessionId === currentSessionRef.current) {
          const audioUrl = findFirstAudioAttachmentUrl(normalizedBackendUrl, incoming);
          if (shouldSpeakRealtimeMessage(incoming, currentSessionRef.current)) {
            enqueueSpeech({
              text: audioUrl ? "" : incoming.text,
              audioUrl,
              mode: incoming.source === "push" ? "push" : "chat",
            });
          }
        }

        try {
          const sessionsPayload = await fetchSessions(normalizedBackendUrl);
          if (!shouldApply()) {
            return;
          }
          useAppStore.getState().setSessions(sessionsPayload.sessions || []);
        } catch (error) {
          console.warn("Failed to refresh sessions after realtime message:", error);
        }
      },
    });
  }, [createConnectionUpdateGuard, enqueueSpeech, normalizedBackendUrl]);

  const createNewSession = useCallback(async () => {
    const created = await createSession(normalizedBackendUrl);
    const sessionsPayload = await fetchSessions(normalizedBackendUrl);
    useAppStore.getState().setSessions(sessionsPayload.sessions || []);
    await loadSession(created.id);
  }, [loadSession, normalizedBackendUrl]);

  const interrupt = useCallback(() => {
    currentAbortRef.current?.abort();
    currentAbortRef.current = null;
    playbackVersionRef.current = createNextPlaybackVersion(playbackVersionRef.current);
    playbackQueueRef.current = Promise.resolve();
    useAppStore.getState().setStreamingMessage(null);
    useAppStore.getState().setConnectionState("idle");
    setAiState(AiStateEnum.INTERRUPTED);
    stopCurrentAudio();
    stopMusic();
  }, [setAiState, stopCurrentAudio, stopMusic]);

  const switchModel = useCallback(async (modelId: string) => {
    setAiState(AiStateEnum.LOADING);
    const nextManifest = await fetchManifest(normalizedBackendUrl, modelId);
    const nextProviderFieldState = resolveProviderFieldState({
      manifest: nextManifest,
      previousValues: useAppStore.getState().providerFieldValues,
      previousManifestValues: useAppStore.getState().providerFieldManifestValues,
    });
    useAppStore.getState().setProviderFieldValues(nextProviderFieldState.values);
    useAppStore.getState().setProviderFieldManifestValues(nextProviderFieldState.manifestValues);
    useAppStore.getState().hydrateManifest(nextManifest);
    setAiState(AiStateEnum.IDLE);
  }, [normalizedBackendUrl, setAiState]);

  const setProviderFieldValue = useCallback((providerId: string, fieldKey: string, value: string) => {
    useAppStore.getState().setProviderFieldValue(providerId, fieldKey, value);
  }, []);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files || []);
    const attachments = await Promise.all(list.map((file) => fileToComposerAttachment(file)));
    for (const attachment of attachments) {
      useAppStore.getState().addComposerAttachment(attachment);
    }
  }, []);

  const addClipboardItems = useCallback(async (items: DataTransferItemList | DataTransferItem[]) => {
    const nextFiles: File[] = [];
    for (const item of Array.from(items || [])) {
      const file = "getAsFile" in item ? item.getAsFile() : null;
      if (file) {
        nextFiles.push(file);
      }
    }
    if (nextFiles.length) {
      await addFiles(nextFiles);
    }
  }, [addFiles]);

  const addCaptureDataUrl = useCallback(async (dataUrl: string, filename = "capture.png") => {
    if (!dataUrl) {
      return;
    }
    const file = await dataUrlToFile(dataUrl, filename);
    const attachment = await fileToComposerAttachment(file);
    useAppStore.getState().addComposerAttachment(attachment);
  }, []);

  const createPendingCaptureAttachment = useCallback((filename = "capture.png") => {
    const attachmentId = createComposerAttachmentId();
    useAppStore.getState().addComposerAttachment({
      id: attachmentId,
      kind: "image",
      filename,
      mimeType: "image/png",
      previewUrl: "",
      source: "base64",
      data: "",
      previewState: "pending",
    });
    return attachmentId;
  }, []);

  const resolvePendingCaptureAttachment = useCallback((attachmentId: string, payload: string | {
    fileUrl: string;
    cleanupToken: string;
    mimeType: string;
  }, filename = "capture.png") => {
    if (!payload) {
      return;
    }
    const nextAttachment: Partial<ComposerAttachment> = typeof payload === "string"
      ? dataUrlToComposerAttachment(payload, filename)
      : {
        ...createTempFileComposerAttachment({
          cleanupToken: payload.cleanupToken,
          fileUrl: payload.fileUrl,
          filename,
          id: attachmentId,
          kind: "image",
          mimeType: payload.mimeType,
        }),
        kind: "image",
        source: "base64",
      };
    useAppStore.getState().updateComposerAttachment(attachmentId, {
      ...nextAttachment,
      id: attachmentId,
      previewState: "ready",
    });
  }, []);

  const failPendingCaptureAttachment = useCallback((attachmentId: string) => {
    const currentAttachment = useAppStore.getState().composerAttachments.find((item) => item.id === attachmentId);
    if (currentAttachment?.cleanupToken) {
      void window.api?.deleteTempScreenshotFile?.(currentAttachment.cleanupToken);
    }
    useAppStore.getState().updateComposerAttachment(attachmentId, {
      previewState: "error",
      cleanupToken: undefined,
      tempFileUrl: undefined,
      previewUrl: "",
      data: "",
    });
  }, []);

  // TODO: not used at all, delete it ?
  const capturePrimaryScreenAttachment = useCallback(async () => {
    const dataUrl = await window.api?.capturePrimaryScreen?.();
    if (!dataUrl) {
      toaster.create({
        title: "截图失败",
        type: "error",
        duration: 2000,
      });
      return;
    }
    await addCaptureDataUrl(dataUrl, "screen-capture.jpg");
  }, [addCaptureDataUrl]);

  const startScreenshotSelection = useCallback(async () => {
    const capture = window.api?.startScreenshotSelection
      ? await window.api.startScreenshotSelection()
      : null;
    if (!capture) {
      toaster.create({
        title: "截图失败",
        type: "error",
        duration: 2000,
      });
      return;
    }
    useAppStore.getState().setScreenshotOverlay({
      fileUrl: capture.fileUrl,
      cleanupToken: capture.cleanupToken,
      filename: capture.filename || "screen-capture.jpg",
    });
  }, []);

  const closeScreenshotSelection = useCallback(() => {
    useAppStore.getState().clearScreenshotOverlay();
  }, []);

  const executeQuickAction = useCallback(async (action: Record<string, unknown>) => {
    const rawType = String(action.type || "").trim().toLowerCase();
    if (rawType === "motion") {
      playMotion(String(action.group || ""), Number(action.index || 0) || 0);
      return;
    }
    if (rawType === "expression") {
      playExpression(String(action.name || ""));
      return;
    }
    await pluginRuntimeRef.current?.dispatchActions([
      {
        type: rawType || "call",
        tool: action.tool || action.name || getQuickActionLabel(action as any),
        args: action.args || {},
      },
    ], {
      playMusic,
      stopMusic,
    });
  }, [playMusic, stopMusic]);

  const executeMotion = useCallback(async (group: string, index = 0) => {
    playMotion(group, index);
  }, []);

  const executeExpression = useCallback(async (name: string) => {
    playExpression(name);
  }, []);

  const setBackgroundFromFile = useCallback(async (targetMode: "window" | "pet", file: File) => {
    const attachment = await fileToComposerAttachment(file);
    useAppStore.getState().setBackgroundForMode(targetMode, attachment.previewUrl);
  }, []);

  const clearBackground = useCallback((targetMode: "window" | "pet") => {
    useAppStore.getState().setBackgroundForMode(targetMode, "");
  }, []);

  const sendComposerMessage = useCallback(async () => {
    const state = useAppStore.getState();
    const draft = state.composerDraft.trim();
    if (state.composerAttachments.some((attachment: ComposerAttachment) => (
      attachment.previewState === "pending" || attachment.previewState === "error"
    ))) {
      return;
    }
    const attachments = await Promise.all(state.composerAttachments.map(attachmentToChatInput));
    if (!draft && !attachments.length) {
      return;
    }
    await sendPayload({
      text: draft,
      attachments,
      clearComposer: true,
    });
  }, [assistantDisplayName, sendPayload]);

  const runAutomationProactive = useCallback(async (reason: "manual" | "scheduled" = "scheduled") => {
    const state = useAppStore.getState();
    if (state.automationRuleState.proactive.running || currentAbortRef.current) {
      return;
    }

    const prompt = String(state.automation.proactive.prompt || "").trim();
    if (!prompt) {
      return;
    }

    state.setAutomationRuleState("proactive", { running: true });
    state.appendAutomationLog(reason === "manual" ? "手动触发：主动搭话" : "自动触发：主动搭话");
    try {
      await sendPayload({
        text: prompt,
        clearComposer: false,
        messageSource: "automation",
        allowMusicActions: state.automation.music.allowAiActions,
        throwOnError: true,
        showUserBubble: false,
        systemNote: i18n.t("shell.automationTriggeredProactive"),
        assistantMeta: assistantDisplayName,
      });
      const finishedAt = Date.now();
      useAppStore.getState().setAutomationRuleState("proactive", {
        running: false,
        lastRunAt: finishedAt,
      });
      useAppStore.getState().appendAutomationLog("主动搭话完成");
    } catch (error) {
      useAppStore.getState().setAutomationRuleState("proactive", { running: false });
      useAppStore.getState().appendAutomationLog(`主动搭话失败：${error}`, "error");
    }
  }, [sendPayload]);

  const runAutomationScreenshot = useCallback(async (reason: "manual" | "scheduled" = "scheduled") => {
    const state = useAppStore.getState();
    if (state.automationRuleState.screenshot.running || currentAbortRef.current) {
      return;
    }

    const prompt = String(state.automation.screenshot.prompt || "").trim();
    if (!prompt) {
      return;
    }

    state.setAutomationRuleState("screenshot", { running: true });
    state.appendAutomationLog(reason === "manual" ? "手动触发：截图观察" : "自动触发：截图观察");
    try {
      const dataUrl = await window.api?.capturePrimaryScreen?.();
      if (!dataUrl) {
        throw new Error("当前环境不支持自动全屏截图");
      }
      const attachment = dataUrlToComposerAttachment(dataUrl, "automation-screen-capture.jpg");
      await sendPayload({
        text: prompt,
        attachments: [await attachmentToChatInput(attachment)],
        clearComposer: false,
        messageSource: "automation",
        allowMusicActions: state.automation.music.allowAiActions,
        throwOnError: true,
        showUserBubble: false,
        systemNote: i18n.t("shell.automationTriggeredScreenshot"),
        assistantMeta: assistantDisplayName,
      });
      const finishedAt = Date.now();
      useAppStore.getState().setAutomationRuleState("screenshot", {
        running: false,
        lastRunAt: finishedAt,
      });
      useAppStore.getState().appendAutomationLog("截图观察完成");
    } catch (error) {
      useAppStore.getState().setAutomationRuleState("screenshot", { running: false });
      useAppStore.getState().appendAutomationLog(`截图观察失败：${error}`, "error");
    }
  }, [sendPayload]);

  useEffect(() => {
    let disposed = false;
    const connectionSessionId = beginBackendConnectionSession(backendConnectionStoreRef.current);

    void reconnect(connectionSessionId, () => disposed);
    startEventsStream(connectionSessionId, () => disposed);
    return () => {
      disposed = true;
      currentAbortRef.current?.abort();
      playbackVersionRef.current = createNextPlaybackVersion(playbackVersionRef.current);
      playbackQueueRef.current = Promise.resolve();
      stopCurrentAudio();
      stopMusic();
      if (eventsCleanupRef.current) {
        eventsCleanupRef.current();
        eventsCleanupRef.current = null;
      }
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [reconnect, startEventsStream, stopCurrentAudio, stopMusic]);

  useEffect(() => {
    if (!manifest) {
      return;
    }

    setConfUid(manifest.selectedModelId);
    setConfName(manifest.model.name);
    setConfigFiles(
      (manifest.models || []).map((model) => ({
        filename: model.id,
        name: model.name,
      })),
    );
    setModelInfo(mapManifestToModelInfo(manifest, normalizedBackendUrl));
  }, [manifest, normalizedBackendUrl, setConfName, setConfUid, setConfigFiles, setModelInfo]);

  useEffect(() => {
    const cleanups: Array<(() => void) | undefined> = [];

    if (window.api?.onInterrupt) {
      cleanups.push(window.api.onInterrupt(() => interrupt()));
    }

    if (window.api?.onSwitchCharacter) {
      cleanups.push(window.api.onSwitchCharacter((filename) => {
        void switchModel(filename);
      }));
    }

    if (window.api?.onToggleScrollToResize) {
      cleanups.push(window.api.onToggleScrollToResize(() => {
        if (!modelInfo) {
          return;
        }
        setModelInfo({
          ...modelInfo,
          scrollToResize: !modelInfo.scrollToResize,
        });
      }));
    }

    if (window.api?.onForceIgnoreMouseChanged) {
      cleanups.push(window.api.onForceIgnoreMouseChanged((isForced) => {
        setForceIgnoreMouse(isForced);
      }));
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup?.();
      }
    };
  }, [interrupt, modelInfo, setForceIgnoreMouse, setModelInfo, switchModel]);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const state = useAppStore.getState();
      applyPersistentToggleState(state.persistentToggleState, state.persistentToggles);
      const bounds = getModelBounds();
      state.setCurrentModelBounds(bounds);
      const modelId = state.manifest?.selectedModelId || state.manifest?.model.id || "";
      if (modelId) {
        applyFocusCenter(resolveFocusCenterConfig({
          manifest: state.manifest,
          focusCenterByModel: state.focusCenterByModel,
          modelId,
        }));
      }
      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (
      !window.api?.getCursorScreenPoint
      || !petOverlayBounds
      || !shouldUseGlobalCursorTracking({
        mode,
        focusCenter: currentFocusCenter,
      })
    ) {
      return undefined;
    }

    let disposed = false;
    let pending = false;
    let timer = 0;

    const syncPointer = () => {
      if (disposed || pending) {
        return;
      }

      pending = true;
      void window.api?.getCursorScreenPoint?.()
        .then((screenPoint) => {
          if (disposed) {
            return;
          }

          const pointer = toRendererPointerFromScreenPoint({
            screenPoint,
            virtualBounds: petOverlayBounds.virtualBounds,
          });
          setTrackedPointerPosition(pointer);
        })
        .catch((error) => {
          console.warn("Failed to sync global cursor position:", error);
        })
        .finally(() => {
          pending = false;
        });
    };

    syncPointer();
    timer = window.setInterval(syncPointer, 40);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [currentFocusCenter, mode, petOverlayBounds]);

  useEffect(() => {
    if (mode !== "pet" || !window.api?.getPetOverlayBounds) {
      setPetOverlayBounds(null);
      return;
    }

    let disposed = false;
    const refreshOverlayBounds = () => {
      void window.api?.getPetOverlayBounds?.().then((overlay) => {
        if (disposed) {
          return;
        }
        setPetOverlayBounds(overlay);
      });
    };

    refreshOverlayBounds();
    const cleanup = window.api.onPetOverlayBoundsChanged?.(() => {
      refreshOverlayBounds();
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [mode]);

  useEffect(() => {
    if (mode !== "pet" || !petOverlayBounds) {
      return;
    }

    const nextAnchor = resolvePetAnchorUpdate({
      currentAnchor: petAnchor,
      nextAnchor: buildPetAnchor(
        currentModelBounds,
        petOverlayBounds.workArea,
        petOverlayBounds.virtualBounds,
        petExpanded,
      ),
      isLocked: petAnchorLocked,
    });

    if (shouldUpdatePetAnchor({ currentAnchor: petAnchor, nextAnchor })) {
      useAppStore.getState().setPetAnchor(nextAnchor);
    }
  }, [currentModelBounds, mode, petAnchor, petAnchorLocked, petExpanded, petOverlayBounds]);

  useEffect(() => {
    const tick = () => {
      const state = useAppStore.getState();
      if (shouldRunAutomationRule({
        config: state.automation,
        ruleKey: "proactive",
        mode,
        ruleState: state.automationRuleState.proactive,
      })) {
        void runAutomationProactive("scheduled");
        return;
      }

      if (shouldRunAutomationRule({
        config: state.automation,
        ruleKey: "screenshot",
        mode,
        ruleState: state.automationRuleState.screenshot,
      })) {
        void runAutomationScreenshot("scheduled");
      }
    };

    const timer = window.setInterval(tick, 15 * 1000);
    // Don't arbitrarily trigger an immediate check until 15s pass, to prevent spam 
    // const bootTimer = window.setTimeout(tick, 1200);

    return () => {
      window.clearInterval(timer);
      // window.clearTimeout(bootTimer);
    };
  }, [mode, runAutomationProactive, runAutomationScreenshot]);

  const value = useMemo<RendererCommandContextValue>(() => ({
    reconnect,
    createNewSession,
    loadSession,
    sendComposerMessage,
    interrupt,
    switchModel,
    setProviderFieldValue,
    addFiles,
    addClipboardItems,
    capturePrimaryScreenAttachment,
    startScreenshotSelection,
    closeScreenshotSelection,
    addCaptureDataUrl,
    createPendingCaptureAttachment,
    resolvePendingCaptureAttachment,
    failPendingCaptureAttachment,
    executeQuickAction,
    executeMotion,
    executeExpression,
    refreshPlugins,
    setBackgroundFromFile,
    clearBackground,
    runAutomationProactive,
    runAutomationScreenshot,
    stopAutomationMusic: async () => stopMusic(),
  }), [
    reconnect,
    createNewSession,
    loadSession,
    sendComposerMessage,
    interrupt,
    switchModel,
    setProviderFieldValue,
    addFiles,
    addClipboardItems,
    capturePrimaryScreenAttachment,
    startScreenshotSelection,
    closeScreenshotSelection,
    addCaptureDataUrl,
    createPendingCaptureAttachment,
    resolvePendingCaptureAttachment,
    failPendingCaptureAttachment,
    executeQuickAction,
    executeMotion,
    executeExpression,
    refreshPlugins,
    setBackgroundFromFile,
    clearBackground,
    runAutomationProactive,
    runAutomationScreenshot,
    stopMusic,
  ]);

  return (
    <RendererCommandContext.Provider value={value}>
      {children}
    </RendererCommandContext.Provider>
  );
}

function useRendererCommandContext(): RendererCommandContextValue {
  const context = useContext(RendererCommandContext);
  if (!context) {
    throw new Error("renderer command hooks must be used inside RendererCommandProvider");
  }
  return context;
}

export function useSessionCommands() {
  const {
    reconnect,
    createNewSession,
    loadSession,
  } = useRendererCommandContext();

  return {
    reconnect,
    createNewSession,
    loadSession,
  };
}

export function useChatCommands() {
  const {
    sendComposerMessage,
    interrupt,
  } = useRendererCommandContext();

  return {
    sendComposerMessage,
    interrupt,
  };
}

export function useComposerCommands() {
  const {
    addFiles,
    addClipboardItems,
    capturePrimaryScreenAttachment,
    startScreenshotSelection,
    closeScreenshotSelection,
    addCaptureDataUrl,
    createPendingCaptureAttachment,
    resolvePendingCaptureAttachment,
    failPendingCaptureAttachment,
  } = useRendererCommandContext();

  return {
    addFiles,
    addClipboardItems,
    capturePrimaryScreenAttachment,
    startScreenshotSelection,
    closeScreenshotSelection,
    addCaptureDataUrl,
    createPendingCaptureAttachment,
    resolvePendingCaptureAttachment,
    failPendingCaptureAttachment,
  };
}

export function useSettingsCommands() {
  const {
    setProviderFieldValue,
    setBackgroundFromFile,
    clearBackground,
  } = useRendererCommandContext();

  return {
    setProviderFieldValue,
    setBackgroundFromFile,
    clearBackground,
  };
}

export function usePetCommands() {
  const {
    startScreenshotSelection,
  } = useRendererCommandContext();

  return {
    startScreenshotSelection,
  };
}

export function useModelCommands() {
  const {
    switchModel,
    executeQuickAction,
    executeMotion,
    executeExpression,
  } = useRendererCommandContext();

  return {
    switchModel,
    executeQuickAction,
    executeMotion,
    executeExpression,
  };
}

export function useVoiceCommands() {
  const { interrupt } = useRendererCommandContext();
  return { interrupt };
}

export function useAutomationCommands() {
  const {
    runAutomationProactive,
    runAutomationScreenshot,
    stopAutomationMusic,
  } = useRendererCommandContext();

  return {
    runAutomationProactive,
    runAutomationScreenshot,
    stopAutomationMusic,
  };
}

export function usePluginCommands() {
  const { refreshPlugins } = useRendererCommandContext();
  return { refreshPlugins };
}
