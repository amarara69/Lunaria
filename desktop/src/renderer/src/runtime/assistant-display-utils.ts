interface ResolveAssistantDisplayNameOptions {
  configName?: string | null;
  manifestName?: string | null;
  fallbackName?: string | null;
}

export function resolveAssistantDisplayName({
  configName,
  manifestName,
  fallbackName = "OpenClaw",
}: ResolveAssistantDisplayNameOptions = {}): string {
  const resolvedConfigName = String(configName || "").trim();
  if (resolvedConfigName) {
    return resolvedConfigName;
  }

  const resolvedManifestName = String(manifestName || "").trim();
  if (resolvedManifestName) {
    return resolvedManifestName;
  }

  return String(fallbackName || "OpenClaw").trim() || "OpenClaw";
}
