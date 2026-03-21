const ALLOWED_OVERRIDE_KEYS = new Set([
  "apiKey",
  "baseUrl",
  "bridgeUrl",
  "model",
  "voice",
  "speed",
  "responseFormat",
  "response_format",
  "otherParams",
  "other_params",
  "rate",
  "pitch",
  "volume",
  "timeoutSeconds",
  "agent",
  "session",
  "token",
  "wsUrl",
]);

export function getProviderOverridesPayload(
  provider,
  values,
  options: { nestKey?: string } | undefined = undefined,
) {
  if (!provider || !values) {
    return {};
  }

  const payload = {};
  for (const field of provider.fields || []) {
    const fieldKey = String(field?.key || "");
    if (!ALLOWED_OVERRIDE_KEYS.has(fieldKey)) {
      continue;
    }

    const value = String(values?.[`${provider.id}.${fieldKey}`] || "").trim();
    if (!value) {
      continue;
    }
    payload[fieldKey] = value;
  }

  const nestKey = String(options?.nestKey || "").trim();
  if (nestKey) {
    return Object.keys(payload).length
      ? { [nestKey]: payload }
      : {};
  }

  return payload;
}
