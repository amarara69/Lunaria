import type {
  AutomationConfig,
  AutomationMusicConfig,
  AutomationRuleConfig,
  AutomationRuleState,
} from "@/domains/types";

type AutomationRuleKey = "proactive" | "screenshot";

type AutomationConfigInput = Partial<
  Omit<AutomationConfig, "proactive" | "screenshot" | "music">
> & {
  proactive?: Partial<AutomationRuleConfig>;
  screenshot?: Partial<AutomationRuleConfig>;
  music?: Partial<AutomationMusicConfig>;
};

export const DEFAULT_AUTOMATION_CONFIG: AutomationConfig = {
  enabled: false,
  onlyPetMode: true,
  proactive: {
    enabled: false,
    intervalMin: 10,
    prompt: "你现在是桌宠陪伴模式。请结合最近对话，自然地主动搭话一句，不要太像闹钟提醒，也不要重复相同开场白。",
  },
  screenshot: {
    enabled: false,
    intervalMin: 30,
    prompt: "这是刚刚截到的用户屏幕。请根据画面内容自然地搭话，可以从画面的某个细节入手，或是结合最近的对话来引入，避免直接描述画面整体或开场白太生硬。同时，如果你觉得用户可能需要帮助，也可以主动提供一些实用建议。",
  },
  music: {
    allowAiActions: true,
    defaultUrl: "",
    volume: 0.35,
    loop: false,
  },
};

export function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, num));
}

export function normalizeAutomationConfig(
  raw: AutomationConfigInput = {},
): AutomationConfig {
  const proactive = raw?.proactive || {};
  const screenshot = raw?.screenshot || {};
  const music = raw?.music || {};

  return {
    ...DEFAULT_AUTOMATION_CONFIG,
    ...raw,
    proactive: {
      ...DEFAULT_AUTOMATION_CONFIG.proactive,
      ...proactive,
      intervalMin: clampNumber(
        proactive.intervalMin,
        1,
        24 * 60,
        DEFAULT_AUTOMATION_CONFIG.proactive.intervalMin,
      ),
      prompt: String(
        proactive.prompt || DEFAULT_AUTOMATION_CONFIG.proactive.prompt,
      ).trim() || DEFAULT_AUTOMATION_CONFIG.proactive.prompt,
    },
    screenshot: {
      ...DEFAULT_AUTOMATION_CONFIG.screenshot,
      ...screenshot,
      intervalMin: clampNumber(
        screenshot.intervalMin,
        1,
        24 * 60,
        DEFAULT_AUTOMATION_CONFIG.screenshot.intervalMin,
      ),
      prompt: String(
        screenshot.prompt || DEFAULT_AUTOMATION_CONFIG.screenshot.prompt,
      ).trim() || DEFAULT_AUTOMATION_CONFIG.screenshot.prompt,
    },
    music: {
      ...DEFAULT_AUTOMATION_CONFIG.music,
      ...music,
      defaultUrl: String(music.defaultUrl || "").trim(),
      volume: clampNumber(
        music.volume,
        0,
        1,
        DEFAULT_AUTOMATION_CONFIG.music.volume,
      ),
      loop: typeof music.loop === "boolean"
        ? music.loop
        : DEFAULT_AUTOMATION_CONFIG.music.loop,
      allowAiActions: typeof music.allowAiActions === "boolean"
        ? music.allowAiActions
        : DEFAULT_AUTOMATION_CONFIG.music.allowAiActions,
    },
  };
}

export function shouldRunAutomationRule({
  config,
  ruleKey,
  mode,
  ruleState,
  now = Date.now(),
}: {
  config?: AutomationConfigInput | AutomationConfig;
  ruleKey: AutomationRuleKey;
  mode?: string | null;
  ruleState?: Partial<AutomationRuleState> | null;
  now?: number;
}): boolean {
  const normalized = normalizeAutomationConfig(config);
  const ruleConfig = normalized[ruleKey];
  if (!normalized.enabled || !ruleConfig?.enabled) {
    return false;
  }
  if (normalized.onlyPetMode && mode !== "pet") {
    return false;
  }
  if (!ruleState || ruleState.running) {
    return false;
  }

  const fallbackInterval = ruleKey === "proactive" ? 10 : 30;
  const intervalMs = clampNumber(
    ruleConfig.intervalMin,
    1,
    24 * 60,
    fallbackInterval,
  ) * 60 * 1000;

  return now - Number(ruleState.lastRunAt || 0) >= intervalMs;
}
