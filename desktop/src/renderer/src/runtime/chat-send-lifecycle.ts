import type { StreamingMessage } from "@/domains/types";
import type {
  ChatAttachmentInput,
  LunariaAttachment,
  LunariaMessage,
} from "@/platform/backend/openclaw-api";

type OptimisticMessageRole = "user" | "assistant" | "system";

interface CreateOptimisticChatMessageOptions {
  sessionId: string;
  role: OptimisticMessageRole;
  text: string;
  attachments?: LunariaAttachment[];
  source?: string;
  nowMs?: number;
  id?: string;
}

interface BuildOptimisticChatSendStateOptions {
  sessionId: string;
  text: string;
  attachments?: ChatAttachmentInput[];
  systemNote?: string;
  showUserBubble?: boolean;
  nowMs?: number;
  makeMessageId?: (role: OptimisticMessageRole, index: number) => string;
  makeStreamingId?: () => string;
}

interface BuildOptimisticChatSendStateResult {
  optimisticMessages: LunariaMessage[];
  streamingMessage: StreamingMessage;
}

function toUnixSeconds(nowMs: number): number {
  return Math.floor(nowMs / 1000);
}

function createDefaultMessageId(role: OptimisticMessageRole, nowMs: number): string {
  return `${role}_${nowMs}_${Math.random().toString(36).slice(2, 8)}`;
}

function mapChatAttachmentsToOptimisticAttachments(
  attachments: ChatAttachmentInput[] = [],
): LunariaAttachment[] {
  return attachments.map((attachment) => ({
    mimeType: attachment.mediaType,
    data: attachment.type === "base64" ? attachment.data : undefined,
    url: attachment.type === "url" ? attachment.data : undefined,
  }));
}

export function createOptimisticChatMessage({
  sessionId,
  role,
  text,
  attachments = [],
  source = "chat",
  nowMs = Date.now(),
  id = createDefaultMessageId(role, nowMs),
}: CreateOptimisticChatMessageOptions): LunariaMessage {
  return {
    id,
    sessionId,
    role,
    text,
    attachments,
    source,
    createdAt: toUnixSeconds(nowMs),
  };
}

export function buildOptimisticChatSendState({
  sessionId,
  text,
  attachments = [],
  systemNote,
  showUserBubble = true,
  nowMs = Date.now(),
  makeMessageId = (role) => createDefaultMessageId(role, nowMs),
  makeStreamingId = () => `stream_${nowMs}`,
}: BuildOptimisticChatSendStateOptions): BuildOptimisticChatSendStateResult {
  const optimisticMessages: LunariaMessage[] = [];

  if (systemNote) {
    optimisticMessages.push(createOptimisticChatMessage({
      sessionId,
      role: "system",
      text: systemNote,
      attachments: [],
      source: "system",
      nowMs,
      id: makeMessageId("system", optimisticMessages.length),
    }));
  }

  if (showUserBubble) {
    optimisticMessages.push(createOptimisticChatMessage({
      sessionId,
      role: "user",
      text,
      attachments: mapChatAttachmentsToOptimisticAttachments(attachments),
      nowMs,
      id: makeMessageId("user", optimisticMessages.length),
    }));
  }

  return {
    optimisticMessages,
    streamingMessage: {
      id: makeStreamingId(),
      sessionId,
      text: "",
      rawText: "",
      createdAt: toUnixSeconds(nowMs),
    },
  };
}
