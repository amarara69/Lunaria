import { Box, Button, HStack, Stack, Text, Textarea } from "@chakra-ui/react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMode } from "@/context/mode-context";
import { useAppStore } from "@/domains/renderer-store";
import {
  useAutomationCommands,
  useModelCommands,
  usePluginCommands,
  useSettingsCommands,
} from "@/app/providers/command-provider";
import { getLunariaScrollbarStyles } from "@/runtime/chat-shell-utils.ts";
import { resolveFocusCenterConfig } from "@/runtime/focus-center-utils.ts";
import {
  normalizeSupportedLanguage,
  resolveBackendUrlCommit,
  resolveProviderFieldLabel,
  resolveProviderFieldPlaceholder,
} from "@/runtime/settings-panel-utils.ts";
import {
  lunariaColors,
  lunariaEyebrowStyles,
  lunariaHeadingStyles,
  lunariaNativeFieldStyles,
  lunariaNativeRangeStyles,
  lunariaPanelStyles,
  lunariaPrimaryButtonStyles,
  lunariaSecondaryButtonStyles,
  lunariaTextareaStyles,
} from "@/theme/lunaria-theme";

const settingsScrollbarStyles = getLunariaScrollbarStyles();

function sectionFieldStyle(overrides?: CSSProperties): CSSProperties {
  return {
    ...lunariaNativeFieldStyles,
    ...overrides,
  };
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Box borderTop="1px solid" borderColor={lunariaColors.border} pt="4" pb="1">
      <Text {...lunariaEyebrowStyles}>{title}</Text>
      {description ? (
        <Text mt="1.5" mb="3" fontSize="sm" color={lunariaColors.textMuted} lineHeight="1.7">
          {description}
        </Text>
      ) : null}
      <Stack gap="3">{children}</Stack>
    </Box>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text fontSize="12px" color={lunariaColors.textMuted} fontWeight="600">
      {children}
    </Text>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        gap: 12,
        alignItems: "center",
        color: lunariaColors.text,
        fontSize: 14,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        style={{ width: 16, height: 16, accentColor: lunariaColors.primary }}
      />
      <span>{label}</span>
    </label>
  );
}

export function SettingsPanel({
  pet = false,
}: {
  pet?: boolean;
}) {
  const { switchModel } = useModelCommands();
  const { setProviderFieldValue, setBackgroundFromFile, clearBackground } = useSettingsCommands();
  const { refreshPlugins } = usePluginCommands();
  const { setMode, mode } = useMode();
  const { t, i18n } = useTranslation();
  const manifest = useAppStore((state) => state.manifest);
  const backendUrl = useAppStore((state) => state.backendUrl);
  const setBackendUrl = useAppStore((state) => state.setBackendUrl);
  const currentProviderId = useAppStore((state) => state.currentProviderId);
  const setCurrentProviderId = useAppStore((state) => state.setCurrentProviderId);
  const providerFieldValues = useAppStore((state) => state.providerFieldValues);
  const ttsEnabled = useAppStore((state) => state.ttsEnabled);
  const setTtsEnabled = useAppStore((state) => state.setTtsEnabled);
  const ttsProvider = useAppStore((state) => state.ttsProvider);
  const setTtsProvider = useAppStore((state) => state.setTtsProvider);
  const petAutoHideSeconds = useAppStore((state) => state.petAutoHideSeconds);
  const setPetAutoHideSeconds = useAppStore((state) => state.setPetAutoHideSeconds);
  const backgroundByMode = useAppStore((state) => state.backgroundByMode);
  const focusCenterByModel = useAppStore((state) => state.focusCenterByModel);
  const setFocusCenterForModel = useAppStore((state) => state.setFocusCenterForModel);
  const pluginCount = useAppStore((state) => state.plugins.length);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [backendUrlDraft, setBackendUrlDraft] = useState(backendUrl);
  const modelId = manifest?.selectedModelId || manifest?.model.id || "";
  const focusCenter = resolveFocusCenterConfig({
    manifest,
    focusCenterByModel,
    modelId,
  });
  const currentLanguage = normalizeSupportedLanguage(i18n.resolvedLanguage || i18n.language);
  const backendUrlCommit = resolveBackendUrlCommit({
    draftUrl: backendUrlDraft,
    currentUrl: backendUrl,
  });

  useEffect(() => {
    setBackendUrlDraft(backendUrl);
  }, [backendUrl]);

  function commitBackendUrlDraft() {
    setBackendUrlDraft(backendUrlCommit.nextUrl);
    if (backendUrlCommit.shouldStore) {
      setBackendUrl(backendUrlCommit.nextUrl);
    }
  }

  return (
    <Stack
      gap="4"
      {...(pet ? lunariaPanelStyles : {})}
      color={lunariaColors.text}
      maxH={pet ? "50vh" : "100%"}
      overflowY="auto"
      css={settingsScrollbarStyles}
      p={pet ? "4" : "0"}
    >
      <Box px={pet ? "1" : "0"}>
        <Text fontSize="xl" {...lunariaHeadingStyles}>{t("settings.title")}</Text>
      </Box>

      <SettingsSection title={t("common.language")}>
        <FieldLabel>{t("settings.languageSelector.label")}</FieldLabel>
        <select
          value={currentLanguage}
          onChange={(event) => void i18n.changeLanguage(normalizeSupportedLanguage(event.target.value))}
          style={sectionFieldStyle({ appearance: "none" })}
        >
          <option value="zh">{t("settings.languageSelector.chinese")}</option>
          <option value="en">{t("settings.languageSelector.english")}</option>
        </select>
      </SettingsSection>

      <SettingsSection title={t("settings.sections.model")}>
        <FieldLabel>{t("settings.fields.character")}</FieldLabel>
        <select
          value={modelId}
          onChange={(event) => void switchModel(event.target.value)}
          style={sectionFieldStyle({ appearance: "none" })}
        >
          {(manifest?.models || []).map((model) => (
            <option key={model.id} value={model.id}>{model.name}</option>
          ))}
        </select>

        <FieldLabel>{t("settings.fields.backendUrl")}</FieldLabel>
        <HStack align="stretch">
          <input
            value={backendUrlDraft}
            onChange={(event) => setBackendUrlDraft(event.target.value)}
            onBlur={commitBackendUrlDraft}
            onKeyDown={(event) => {
              if (event.key !== "Enter") {
                return;
              }
              event.preventDefault();
              commitBackendUrlDraft();
              event.currentTarget.blur();
            }}
            placeholder="http://127.0.0.1:18080"
            style={{
              ...sectionFieldStyle(),
              flex: 1,
            }}
          />
          <Button
            size="sm"
            alignSelf="stretch"
            {...lunariaSecondaryButtonStyles}
            disabled={!backendUrlCommit.shouldStore && backendUrlDraft === backendUrlCommit.nextUrl}
            onClick={commitBackendUrlDraft}
          >
            {t("common.save")}
          </Button>
        </HStack>
      </SettingsSection>

      <SettingsSection title={t("settings.sections.provider")}>
        <FieldLabel>{t("settings.fields.currentProvider")}</FieldLabel>
        <select
          value={currentProviderId}
          onChange={(event) => setCurrentProviderId(event.target.value)}
          style={sectionFieldStyle({ appearance: "none" })}
        >
          {(manifest?.model.chat.providers || []).map((provider) => (
            <option key={provider.id} value={provider.id}>{provider.name}</option>
          ))}
        </select>

        <Stack gap="2.5">
          {(manifest?.model.chat.providers.find((provider) => provider.id === currentProviderId)?.fields || []).map((field) => {
            const label = resolveProviderFieldLabel(field);
            return (
              <Box key={`${currentProviderId}.${field.key}`}>
                <FieldLabel>{label}</FieldLabel>
                <input
                  type={field.input === "password" ? "password" : "text"}
                  value={providerFieldValues[`${currentProviderId}.${field.key}`] ?? String(field.value ?? field.defaultValue ?? "")}
                  onChange={(event) => setProviderFieldValue(currentProviderId, field.key, event.target.value)}
                  placeholder={resolveProviderFieldPlaceholder(field)}
                  style={sectionFieldStyle({ marginTop: 6 })}
                />
              </Box>
            );
          })}
        </Stack>
      </SettingsSection>

      <SettingsSection title={t("settings.sections.voice")}>
        <ToggleRow label={t("settings.toggles.enableTts")} checked={ttsEnabled} onChange={setTtsEnabled} />
        <FieldLabel>{t("settings.fields.ttsProvider")}</FieldLabel>
        <select
          value={ttsProvider}
          onChange={(event) => setTtsProvider(event.target.value)}
          style={sectionFieldStyle({ appearance: "none" })}
        >
          {(manifest?.model.chat.tts.providers || []).map((provider) => (
            <option key={provider.id} value={provider.id}>{provider.name}</option>
          ))}
        </select>

        <Stack gap="2.5">
          {(manifest?.model.chat.tts.providers.find((provider) => provider.id === ttsProvider)?.fields || []).map((field) => {
            const label = resolveProviderFieldLabel(field);
            return (
              <Box key={`${ttsProvider}.${field.key}`}>
                <FieldLabel>{label}</FieldLabel>
                <input
                  type={field.input === "password" ? "password" : "text"}
                  value={providerFieldValues[`${ttsProvider}.${field.key}`] ?? String(field.value ?? field.defaultValue ?? "")}
                  onChange={(event) => setProviderFieldValue(ttsProvider, field.key, event.target.value)}
                  placeholder={resolveProviderFieldPlaceholder(field)}
                  style={sectionFieldStyle({ marginTop: 6 })}
                />
              </Box>
            );
          })}
        </Stack>

        <ToggleRow
          label={t("settings.toggles.followCursor")}
          checked={focusCenter.enabled !== false}
          onChange={(checked) => setFocusCenterForModel(modelId, { enabled: checked })}
        />
        <Text fontSize="12px" color={lunariaColors.textMuted}>
          {t("settings.fields.headRatio", { value: Number(focusCenter.headRatio ?? 0.25).toFixed(2) })}
        </Text>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={Number(focusCenter.headRatio ?? 0.25)}
          onChange={(event) => setFocusCenterForModel(modelId, { headRatio: Number(event.target.value) })}
          disabled={focusCenter.enabled === false}
          style={lunariaNativeRangeStyles}
        />
      </SettingsSection>

      <SettingsSection title={t("settings.sections.background")}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void setBackgroundFromFile(mode, file);
            }
            event.target.value = "";
          }}
        />
        <HStack gap="2" flexWrap="wrap">
          <Button size="sm" {...lunariaPrimaryButtonStyles} onClick={() => fileInputRef.current?.click()}>{t("common.upload")}</Button>
          <Button size="sm" {...lunariaSecondaryButtonStyles} onClick={() => clearBackground(mode)}>{t("common.reset")}</Button>
        </HStack>
        <Text fontSize="12px" color={lunariaColors.textMuted}>
          {backgroundByMode[mode]
            ? t("settings.fields.backgroundStatusCustom")
            : t("settings.fields.backgroundStatusDefault")}
        </Text>

        <Text fontSize="12px" color={lunariaColors.textMuted}>
          {t("settings.fields.petAutoHideSeconds", { value: petAutoHideSeconds })}
        </Text>
        <input
          type="range"
          min="0"
          max="60"
          step="1"
          value={petAutoHideSeconds}
          onChange={(event) => setPetAutoHideSeconds(Number(event.target.value))}
          style={lunariaNativeRangeStyles}
        />
      </SettingsSection>

      <SettingsSection title={t("settings.sections.plugins")}>
        <Text fontSize="sm" color={lunariaColors.textMuted}>{t("settings.fields.pluginCount", { count: pluginCount })}</Text>
        <Button size="sm" {...lunariaSecondaryButtonStyles} onClick={() => void refreshPlugins()}>
          {t("settings.actions.refreshPlugins")}
        </Button>
      </SettingsSection>

      <AutomationPanel />

      {pet ? (
        <Button mt="2" {...lunariaPrimaryButtonStyles} onClick={() => setMode("window")}>{t("settings.actions.returnToWindow")}</Button>
      ) : null}
    </Stack>
  );
}

function AutomationPanel() {
  const {
    runAutomationProactive,
    runAutomationScreenshot,
    stopAutomationMusic,
  } = useAutomationCommands();
  const { t } = useTranslation();
  const automation = useAppStore((state) => state.automation);
  const automationLogs = useAppStore((state) => state.automationLogs);
  const setAutomationConfig = useAppStore((state) => state.setAutomationConfig);
  const setAutomationRuleConfig = useAppStore((state) => state.setAutomationRuleConfig);
  const setAutomationMusicConfig = useAppStore((state) => state.setAutomationMusicConfig);
  const clearAutomationLogs = useAppStore((state) => state.clearAutomationLogs);

  return (
    <SettingsSection title={t("settings.sections.automation")}>
      <ToggleRow
        label={t("settings.toggles.enableAutomation")}
        checked={automation.enabled}
        onChange={(checked) => setAutomationConfig({ enabled: checked })}
      />
      <ToggleRow
        label={t("settings.toggles.automationOnlyPetMode")}
        checked={automation.onlyPetMode}
        onChange={(checked) => setAutomationConfig({ onlyPetMode: checked })}
      />

      <Box>
        <Text {...lunariaEyebrowStyles}>{t("settings.subsections.proactive")}</Text>
        <Stack mt="3" gap="3">
          <ToggleRow
            label={t("settings.toggles.enableProactive")}
            checked={automation.proactive.enabled}
            onChange={(checked) => setAutomationRuleConfig("proactive", { enabled: checked })}
          />
          <FieldLabel>{t("settings.fields.proactiveInterval")}</FieldLabel>
          <input
            type="number"
            min="1"
            max="1440"
            step="1"
            value={automation.proactive.intervalMin}
            onChange={(event) => setAutomationRuleConfig("proactive", { intervalMin: Number(event.target.value) })}
            style={sectionFieldStyle()}
          />
          <FieldLabel>{t("settings.fields.proactivePrompt")}</FieldLabel>
          <Textarea
            value={automation.proactive.prompt}
            onChange={(event) => setAutomationRuleConfig("proactive", { prompt: event.target.value })}
            {...lunariaTextareaStyles}
            minH="100px"
          />
          <Button size="sm" {...lunariaSecondaryButtonStyles} onClick={() => void runAutomationProactive("manual")}>
            {t("settings.actions.runProactive")}
          </Button>
        </Stack>
      </Box>

      <Box>
        <Text {...lunariaEyebrowStyles}>{t("settings.subsections.screenshot")}</Text>
        <Stack mt="3" gap="3">
          <ToggleRow
            label={t("settings.toggles.enableScreenshot")}
            checked={automation.screenshot.enabled}
            onChange={(checked) => setAutomationRuleConfig("screenshot", { enabled: checked })}
          />
          <FieldLabel>{t("settings.fields.screenshotInterval")}</FieldLabel>
          <input
            type="number"
            min="1"
            max="1440"
            step="1"
            value={automation.screenshot.intervalMin}
            onChange={(event) => setAutomationRuleConfig("screenshot", { intervalMin: Number(event.target.value) })}
            style={sectionFieldStyle()}
          />
          <FieldLabel>{t("settings.fields.screenshotPrompt")}</FieldLabel>
          <Textarea
            value={automation.screenshot.prompt}
            onChange={(event) => setAutomationRuleConfig("screenshot", { prompt: event.target.value })}
            {...lunariaTextareaStyles}
            minH="100px"
          />
          <Button size="sm" {...lunariaSecondaryButtonStyles} onClick={() => void runAutomationScreenshot("manual")}>
            {t("settings.actions.runScreenshot")}
          </Button>
        </Stack>
      </Box>

      <Box>
        <Text {...lunariaEyebrowStyles}>{t("settings.subsections.music")}</Text>
        <Stack mt="3" gap="3">
          <ToggleRow
            label={t("settings.toggles.allowAiMusic")}
            checked={automation.music.allowAiActions}
            onChange={(checked) => setAutomationMusicConfig({ allowAiActions: checked })}
          />
          <FieldLabel>{t("settings.fields.musicUrl")}</FieldLabel>
          <input
            value={automation.music.defaultUrl}
            onChange={(event) => setAutomationMusicConfig({ defaultUrl: event.target.value })}
            placeholder="https://.../music.mp3"
            style={sectionFieldStyle()}
          />
          <Text fontSize="12px" color={lunariaColors.textMuted}>{t("settings.fields.musicVolume", { value: automation.music.volume.toFixed(2) })}</Text>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={automation.music.volume}
            onChange={(event) => setAutomationMusicConfig({ volume: Number(event.target.value) })}
            style={lunariaNativeRangeStyles}
          />
          <ToggleRow
            label={t("settings.toggles.musicLoop")}
            checked={automation.music.loop}
            onChange={(checked) => setAutomationMusicConfig({ loop: checked })}
          />
          <Button size="sm" {...lunariaSecondaryButtonStyles} onClick={() => void stopAutomationMusic()}>
            {t("settings.actions.stopMusic")}
          </Button>
        </Stack>
      </Box>

      <Box>
        <HStack justify="space-between">
          <Text {...lunariaEyebrowStyles}>{t("settings.subsections.logs")}</Text>
          {automationLogs.length ? (
            <Button size="xs" {...lunariaSecondaryButtonStyles} onClick={clearAutomationLogs}>{t("settings.actions.clearLogs")}</Button>
          ) : null}
        </HStack>
        <Stack
          mt="3"
          maxH="220px"
          overflowY="auto"
          css={settingsScrollbarStyles}
          {...lunariaPanelStyles}
          p="3"
          gap="2"
        >
          {automationLogs.length ? automationLogs.slice().reverse().map((item) => (
            <HStack key={item.id} align="start" gap="3">
              <Text minW="68px" fontSize="11px" color={lunariaColors.textSubtle}>{item.timeLabel}</Text>
              <Text
                fontSize="12px"
                color={
                  item.status === "error"
                    ? "#a75f59"
                    : item.status === "warn"
                      ? "#9b6f40"
                      : lunariaColors.text
                }
              >
                {item.text}
              </Text>
            </HStack>
          )) : (
            <Text fontSize="12px" color={lunariaColors.textMuted}>{t("settings.emptyLogs")}</Text>
          )}
        </Stack>
      </Box>
    </SettingsSection>
  );
}
