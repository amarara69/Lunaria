import type { ComposerAttachment } from "@/domains/types";
import type { ChatAttachmentInput } from "@/platform/backend/openclaw-api";

type AttachmentDraft = ComposerAttachment;

interface DataUrlParts {
  data: string;
  mediaType: string;
}

interface CreateFileComposerAttachmentOptions {
  file?: File;
  id?: string;
  previewUrl?: string;
}

interface CreateTempFileComposerAttachmentOptions {
  cleanupToken?: string;
  fileUrl?: string;
  filename?: string;
  id?: string;
  kind?: ComposerAttachment["kind"];
  mimeType?: string;
}

interface ResolveComposerAttachmentChatInputOptions {
  attachment?: Partial<ComposerAttachment> | null;
  resolvedDataUrl?: string;
}

function extractDataUrlParts(dataUrl: string): DataUrlParts | null {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return null;
  }

  return {
    data: match[2] || "",
    mediaType: match[1] || "application/octet-stream",
  };
}

function detectAttachmentKind(
  mimeType = "application/octet-stream",
): ComposerAttachment["kind"] {
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("audio/")) {
    return "audio";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  return "file";
}

export function createFileComposerAttachment({
  file,
  id,
  previewUrl = "",
}: CreateFileComposerAttachmentOptions = {}): AttachmentDraft {
  const mimeType = file?.type || "application/octet-stream";
  return {
    data: "",
    file,
    filename: file?.name || "attachment",
    id: id || "",
    kind: detectAttachmentKind(mimeType),
    mimeType,
    previewUrl,
    source: "base64",
  };
}

export function createTempFileComposerAttachment({
  cleanupToken,
  fileUrl,
  filename = "capture.png",
  id,
  kind = "image",
  mimeType = "image/png",
}: CreateTempFileComposerAttachmentOptions = {}): AttachmentDraft {
  return {
    cleanupToken,
    data: "",
    filename,
    id: id || "",
    kind,
    mimeType,
    previewUrl: fileUrl || "",
    source: "base64",
    tempFileUrl: fileUrl || "",
  };
}

export function resolveComposerAttachmentChatInput({
  attachment,
  resolvedDataUrl,
}: ResolveComposerAttachmentChatInputOptions = {}): ChatAttachmentInput {
  if (attachment?.data) {
    return {
      data: attachment.data,
      mediaType: attachment.mimeType,
      type: attachment.source,
    };
  }

  const resolvedPayload = extractDataUrlParts(resolvedDataUrl);
  if (!resolvedPayload) {
    throw new Error("missing attachment payload");
  }

  return {
    data: resolvedPayload.data,
    mediaType: resolvedPayload.mediaType || attachment?.mimeType,
    type: "base64",
  };
}
