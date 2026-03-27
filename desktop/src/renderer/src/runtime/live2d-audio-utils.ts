type LipSyncPlaybackMode = "none" | "wav-handler" | "realtime";

interface Live2DModelLike {
  _externalLipSyncValue: number | null;
  _wavFileHandler?: {
    start: (source: string) => void;
  } | null;
}

interface Live2DAdapterLike {
  getModel?: () => Live2DModelLike | null;
}

interface Live2DManagerLike {
  getModel?: (index: number) => Live2DModelLike | null;
}

interface LunariaWindow extends Window {
  getLAppAdapter?: () => Live2DAdapterLike | undefined;
  getLive2DManager?: () => Live2DManagerLike | undefined;
  webkitAudioContext?: typeof AudioContext;
}

interface CapturableAudioElement extends HTMLAudioElement {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
}

export function getLipSyncPlaybackMode({
  audioMimeType = "",
  audioSource = "",
}: {
  audioMimeType?: string;
  audioSource?: string;
}): LipSyncPlaybackMode {
  const mimeType = String(audioMimeType || "").toLowerCase();
  const source = String(audioSource || "").trim().toLowerCase();
  if (!source) {
    return "none";
  }

  if (
    mimeType.includes("wav")
    || /^data:audio\/(?:x-)?wav/i.test(source)
    || /\.wav(?:[?#].*)?$/i.test(source)
  ) {
    return "wav-handler";
  }

  return "realtime";
}

export function getActiveLive2DModel(): Live2DModelLike | null {
  const runtimeWindow = window as LunariaWindow;
  const adapter = runtimeWindow.getLAppAdapter?.();
  return adapter?.getModel?.() || runtimeWindow.getLive2DManager?.()?.getModel?.(0) || null;
}

export function createRealtimeLipSyncCleanup(
  audio: CapturableAudioElement,
  model: Live2DModelLike | null,
): (() => void) | null {
  const runtimeWindow = window as LunariaWindow;
  const AudioContextCtor = globalThis.AudioContext || runtimeWindow.webkitAudioContext;
  if (!AudioContextCtor || !model) {
    return null;
  }

  try {
    const audioContext = new AudioContextCtor();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.65;
    const captureStream = audio.captureStream?.bind(audio)
      || audio.mozCaptureStream?.bind(audio);
    const stream = captureStream ? captureStream() : null;
    if (!stream) {
      void audioContext.close().catch(() => {});
      return null;
    }

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    const data = new Uint8Array(analyser.fftSize);
    let frameId = 0;
    let disposed = false;

    const update = () => {
      if (disposed) {
        return;
      }

      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let index = 0; index < data.length; index += 1) {
        const normalized = (data[index] - 128) / 128;
        sum += normalized * normalized;
      }

      const rms = Math.sqrt(sum / data.length);
      model._externalLipSyncValue = Math.min(1, rms * 6);

      if (!audio.ended) {
        frameId = requestAnimationFrame(update);
      }
    };

    void audioContext.resume().catch(() => {});
    frameId = requestAnimationFrame(update);

    return () => {
      disposed = true;
      if (frameId) {
        cancelAnimationFrame(frameId);
      }
      model._externalLipSyncValue = null;
      source.disconnect();
      void audioContext.close().catch(() => {});
    };
  } catch (error) {
    console.warn("Failed to initialize realtime lip sync:", error);
    return null;
  }
}
