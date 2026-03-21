export interface LunariaProviderField {
  key: string;
  label: string;
  input: string;
  placeholder?: string;
  defaultValue?: string;
  value?: string;
}

export interface LunariaProvider {
  id: string;
  type: string;
  name: string;
  fields: LunariaProviderField[];
  editableFields: string[];
}

export interface LunariaMotion {
  group: string;
  index: number;
  file: string;
  label: string;
  duration: number;
  name: string;
}

export interface LunariaExpression {
  name: string;
  file: string;
  index: number;
}

export interface LunariaQuickAction {
  id?: string;
  type?: string;
  label?: string;
  [key: string]: unknown;
}

export interface LunariaModelSummary {
  id: string;
  name: string;
}

export interface LunariaTtsProvider {
  id: string;
  name: string;
  fields: LunariaProviderField[];
  editableFields: string[];
}

export interface LunariaManifest {
  selectedModelId: string;
  models: LunariaModelSummary[];
  model: {
    id: string;
    name: string;
    modelJson: string;
    root: string;
    exists: boolean;
    live2d?: {
      focusCenter?: Record<string, unknown>;
    };
    motions: LunariaMotion[];
    expressions: LunariaExpression[];
    quickActions: LunariaQuickAction[];
    persistentToggles?: Record<string, boolean>;
    lipSyncParamId?: string;
    chat: {
      enabled: boolean;
      defaultProviderId: string;
      providers: LunariaProvider[];
      note?: string;
      tts: {
        enabled: boolean;
        provider: string;
        pushProvider?: string;
        softBreakMaxChars?: number;
        minSegmentChars?: number;
        providers: LunariaTtsProvider[];
      };
    };
  };
  live2d?: {
    focusCenter?: Record<string, unknown>;
  };
}

export interface LunariaSession {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface LunariaAttachment {
  kind?: string;
  mimeType?: string;
  url?: string;
  data?: string;
  filename?: string;
}

export interface LunariaMessage {
  id: string;
  sessionId: string;
  role: string;
  text: string;
  rawText?: string;
  attachments?: LunariaAttachment[];
  source?: string;
  meta?: string;
  createdAt: number;
}

export interface StreamStartPayload {
  ok: boolean;
  provider?: string;
  providerLabel?: string;
  agent?: string;
  session?: string;
}

export interface StreamChunkPayload {
  kind?: string;
  visibleText: string;
  rawText?: string;
}

export interface StreamTimelineUnit {
  i: number;
  text: string;
  directives?: unknown[];
  audioUrl?: string;
  audioMs?: number;
  contentType?: string;
  error?: string;
}

export interface StreamActionPayload {
  actions?: unknown[];
}

export interface StreamFinalPayload {
  ok: boolean;
  messageId: string;
  userText: string;
  reply: string;
  rawReply?: string;
  actions?: unknown[];
  tts?: {
    enabled?: boolean;
  };
  provider?: string;
  providerLabel?: string;
  model?: string;
  usage?: Record<string, unknown>;
  agent?: string;
  session?: string;
  sessionKey?: string;
  state?: string;
  images?: Array<Record<string, unknown>>;
}

export interface StreamErrorPayload {
  error: string;
}

export type ChatStreamEvent =
  | { event: 'start'; data: StreamStartPayload }
  | { event: 'chunk'; data: StreamChunkPayload }
  | { event: 'timeline'; data: { unit: StreamTimelineUnit } }
  | { event: 'action'; data: StreamActionPayload }
  | { event: 'final'; data: StreamFinalPayload }
  | { event: 'error'; data: StreamErrorPayload };

export interface EventsEnvelope<T = Record<string, unknown>> {
  seq: number;
  type: string;
  ts: number;
  payload: T;
}

export interface ChatAttachmentInput {
  type: 'base64' | 'url';
  data: string;
  mediaType?: string;
}

export interface SendChatBody {
  sessionId: string;
  modelId: string;
  providerId: string;
  text: string;
  historyText?: string;
  attachments?: ChatAttachmentInput[];
  ttsEnabled?: boolean;
  ttsProvider?: string;
  assistantMeta?: string;
  messageSource?: string;
  [key: string]: unknown;
}

export function normalizeBaseUrl(url: string): string {
  let value = String(url || '').trim();
  if (!value) {
    return 'http://127.0.0.1:18080';
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `http://${value}`;
  }

  try {
    const parsed = new URL(value);
    const protocol = parsed.protocol === 'ws:'
      ? 'http:'
      : parsed.protocol === 'wss:'
        ? 'https:'
        : parsed.protocol;

    let pathname = parsed.pathname.replace(/\/+$/, '');
    if (pathname === '/client-ws' || pathname === '/ws') {
      pathname = '';
    }

    return `${protocol}//${parsed.host}${pathname}`;
  } catch {
    return value.replace(/\/+$/, '');
  }
}

export function buildBackendUrl(baseUrl: string, path: string): string {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchManifest(baseUrl: string, modelId?: string): Promise<LunariaManifest> {
  const url = buildBackendUrl(
    baseUrl,
    modelId ? `/api/model?model=${encodeURIComponent(modelId)}` : '/api/model',
  );
  return requestJson<LunariaManifest>(url);
}

export async function fetchSessions(baseUrl: string): Promise<{
  sessions: LunariaSession[];
  currentId: string;
}> {
  return requestJson(buildBackendUrl(baseUrl, '/api/sessions'));
}

export async function createSession(baseUrl: string, name?: string): Promise<LunariaSession> {
  const response = await requestJson<{ ok: boolean; session: LunariaSession }>(
    buildBackendUrl(baseUrl, '/api/sessions'),
    {
      method: 'POST',
      body: JSON.stringify({ name }),
    },
  );
  return response.session;
}

export async function selectSession(baseUrl: string, sessionId: string): Promise<void> {
  await requestJson(
    buildBackendUrl(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/select`),
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  );
}

export async function fetchMessages(baseUrl: string, sessionId: string): Promise<LunariaMessage[]> {
  const response = await requestJson<{ sessionId: string; messages: LunariaMessage[] }>(
    buildBackendUrl(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/messages`),
  );
  return response.messages || [];
}

function parseSseBlock(block: string): { event: string; data: string } | null {
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  if (!lines.length) {
    return null;
  }

  let event = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  return {
    event,
    data: dataLines.join('\n'),
  };
}

function findSseSeparator(buffer: string): { index: number; length: number } | null {
  const match = /\r?\n\r?\n/.exec(buffer);
  if (!match || match.index === undefined) {
    return null;
  }
  return {
    index: match.index,
    length: match[0].length,
  };
}

export async function streamChat(
  baseUrl: string,
  body: SendChatBody,
  handlers: {
    onEvent: (event: ChatStreamEvent) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const response = await fetch(buildBackendUrl(baseUrl, '/api/chat/stream'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: handlers.signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('chat stream body is empty');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let separator = findSseSeparator(buffer);
    while (separator) {
      const rawBlock = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator.length);
      const parsed = parseSseBlock(rawBlock);
      if (parsed?.data) {
        const payload = JSON.parse(parsed.data);
        handlers.onEvent({
          event: parsed.event as ChatStreamEvent['event'],
          data: payload,
        } as ChatStreamEvent);
      }
      separator = findSseSeparator(buffer);
    }

    if (done) {
      break;
    }
  }
}

export function openEventsStream(
  baseUrl: string,
  options: {
    since?: number;
    onOpen?: () => void;
    onError?: () => void;
    onEvent: (event: EventsEnvelope) => void;
  },
): () => void {
  const streamUrl = buildBackendUrl(
    baseUrl,
    `/api/events/stream?since=${encodeURIComponent(String(options.since || 0))}`,
  );
  const eventSource = new EventSource(streamUrl);

  eventSource.onopen = () => {
    options.onOpen?.();
  };

  eventSource.onerror = () => {
    options.onError?.();
  };

  const forward = (event: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(event.data) as EventsEnvelope;
      options.onEvent(payload);
    } catch (error) {
      console.error('Failed to parse backend event stream payload:', error);
    }
  };

  eventSource.onmessage = forward;
  eventSource.addEventListener('stream.ready', forward as EventListener);
  eventSource.addEventListener('message.created', forward as EventListener);

  return () => {
    eventSource.close();
  };
}

export async function requestTts(
  baseUrl: string,
  body: {
    text: string;
    provider?: string;
    mode?: string;
    [key: string]: unknown;
  },
): Promise<Blob> {
  const response = await fetch(buildBackendUrl(baseUrl, '/api/tts'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${response.status} ${response.statusText}`);
  }

  return response.blob();
}
