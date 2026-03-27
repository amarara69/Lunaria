import type { StreamingMessage } from "@/domains/types";
import type {
  ChatStreamEvent,
  StreamTimelineUnit,
} from "@/platform/backend/openclaw-api";

interface ReduceChatStreamEventOptions {
  event: ChatStreamEvent;
  streamingMessage: StreamingMessage | null;
  subtitle: string;
  actions: unknown[];
}

interface ReduceChatStreamEventResult {
  streamingMessage: StreamingMessage | null;
  subtitle: string;
  actions: unknown[];
  timelineUnit?: StreamTimelineUnit;
  error?: string;
}

export function reduceChatStreamEvent({
  event,
  streamingMessage,
  subtitle,
  actions,
}: ReduceChatStreamEventOptions): ReduceChatStreamEventResult {
  if (event.event === "chunk") {
    return {
      streamingMessage: streamingMessage
        ? {
          ...streamingMessage,
          text: event.data.visibleText || streamingMessage.text,
          rawText: event.data.rawText || streamingMessage.rawText,
        }
        : streamingMessage,
      subtitle: event.data.visibleText || subtitle,
      actions,
    };
  }

  if (event.event === "timeline") {
    return {
      streamingMessage,
      subtitle,
      actions,
      timelineUnit: event.data.unit,
    };
  }

  if (event.event === "action") {
    return {
      streamingMessage,
      subtitle,
      actions: [
        ...actions,
        ...(event.data.actions || []),
      ],
    };
  }

  if (event.event === "final") {
    return {
      streamingMessage,
      subtitle: event.data.reply || subtitle,
      actions: [
        ...actions,
        ...(event.data.actions || []),
      ],
    };
  }

  if (event.event === "error") {
    return {
      streamingMessage,
      subtitle,
      actions,
      error: event.data.error || "chat stream error",
    };
  }

  return {
    streamingMessage,
    subtitle,
    actions,
  };
}
