interface MusicActionHandlers {
  playMusic: (payload: { url?: string; trackId?: string }) => Promise<void> | void;
  stopMusic: () => Promise<void> | void;
}

interface PluginRuntimeWithDispatch {
  dispatchActions?: (
    actions: unknown[],
    depsForActions: MusicActionHandlers,
  ) => Promise<void> | void;
}

interface DispatchChatPlaybackActionsOptions extends MusicActionHandlers {
  pluginRuntime?: PluginRuntimeWithDispatch | null;
  actions: unknown[];
  allowMusicActions?: boolean;
}

export function filterMusicActions(actions: unknown[], allowMusicActions: boolean): unknown[] {
  if (allowMusicActions) {
    return Array.isArray(actions) ? actions : [];
  }

  return (Array.isArray(actions) ? actions : []).filter((action) => {
    const type = String((action as Record<string, unknown>)?.type || "").trim().toLowerCase();
    return type !== "play_music" && type !== "stop_music";
  });
}

export async function dispatchChatPlaybackActions({
  pluginRuntime,
  actions,
  allowMusicActions = true,
  playMusic,
  stopMusic,
}: DispatchChatPlaybackActionsOptions): Promise<void> {
  await pluginRuntime?.dispatchActions?.(filterMusicActions(actions, allowMusicActions), {
    playMusic,
    stopMusic,
  });
}

export async function waitForPlaybackQueue(
  playbackQueue: Promise<unknown>,
  onError?: (error: unknown) => void,
): Promise<void> {
  await Promise.resolve(playbackQueue).catch((error) => {
    onError?.(error);
  });
}
