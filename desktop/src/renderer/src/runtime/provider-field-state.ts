function getManifestFieldValue(field) {
  return String(field?.value ?? field?.defaultValue ?? "");
}

function getEditableProviders(manifest) {
  return [
    ...(manifest?.model?.chat?.providers || []),
    ...(manifest?.model?.chat?.tts?.providers || []),
  ];
}

export function resolveProviderFieldState({
  manifest,
  previousValues = {},
  previousManifestValues = {},
}) {
  const values = {};
  const manifestValues = {};

  for (const provider of getEditableProviders(manifest)) {
    const providerId = String(provider?.id || "").trim();
    if (!providerId) {
      continue;
    }

    for (const field of provider.fields || []) {
      const fieldKey = String(field?.key || "").trim();
      if (!fieldKey) {
        continue;
      }

      const storageKey = `${providerId}.${fieldKey}`;
      const nextManifestValue = getManifestFieldValue(field);
      const previousValue = previousValues[storageKey];
      const previousManifestValue = previousManifestValues[storageKey];

      manifestValues[storageKey] = nextManifestValue;

      if (previousValue === undefined) {
        values[storageKey] = nextManifestValue;
        continue;
      }

      if (previousManifestValue === undefined || previousValue === previousManifestValue) {
        values[storageKey] = nextManifestValue;
        continue;
      }

      values[storageKey] = String(previousValue);
    }
  }

  return {
    values,
    manifestValues,
  };
}
