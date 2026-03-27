interface Live2DInitializationStore {
  activeSessionId: number;
}

type Live2DInitializationGlobal = typeof globalThis & {
  __OPENCLAW_LIVE2D_INIT_STORE__?: Live2DInitializationStore;
};

function toPositiveInteger(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) {
    return fallback;
  }
  return numeric;
}

export function getLive2DInitializationStore(
  globalObject: Live2DInitializationGlobal = globalThis,
): Live2DInitializationStore {
  if (!globalObject.__OPENCLAW_LIVE2D_INIT_STORE__) {
    globalObject.__OPENCLAW_LIVE2D_INIT_STORE__ = {
      activeSessionId: 0,
    };
  }

  return globalObject.__OPENCLAW_LIVE2D_INIT_STORE__;
}

export function beginLive2DInitializationSession(
  store?: Live2DInitializationStore,
): number {
  const targetStore = store || getLive2DInitializationStore();
  const nextSessionId = toPositiveInteger(targetStore.activeSessionId) + 1;
  targetStore.activeSessionId = nextSessionId;
  return nextSessionId;
}

export function getActiveLive2DInitializationSession(
  store?: Live2DInitializationStore,
): number {
  const targetStore = store || getLive2DInitializationStore();
  return toPositiveInteger(targetStore.activeSessionId);
}

export function isLive2DInitializationSessionCurrent(
  sessionId: unknown,
  store?: Live2DInitializationStore,
): boolean {
  const normalizedSessionId = toPositiveInteger(sessionId, -1);
  if (normalizedSessionId <= 0) {
    return false;
  }

  return normalizedSessionId === getActiveLive2DInitializationSession(store);
}

export function shouldContinueLive2DAssetLoad({
  sessionId,
  store,
  isStarted,
  isInitialized,
  isReleased = false,
}: {
  sessionId?: unknown;
  store?: Live2DInitializationStore;
  isStarted?: boolean;
  isInitialized?: boolean;
  isReleased?: boolean;
} = {}): boolean {
  return Boolean(
    !isReleased
    && isStarted
    && isInitialized
    && isLive2DInitializationSessionCurrent(sessionId, store),
  );
}
