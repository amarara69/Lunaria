interface ShouldAutoScrollMessageListOptions {
  previousSessionId?: string | null;
  nextSessionId?: string | null;
  previousMessageCount?: number;
  nextMessageCount?: number;
  previousStreamingText?: string | null;
  nextStreamingText?: string | null;
}

interface GetLunariaScrollbarStylesOptions {
  hidden?: boolean;
}

type LunariaScrollbarStyles = Record<string, string | Record<string, string>>;

export function shouldAutoScrollMessageList({
  previousSessionId,
  nextSessionId,
  previousMessageCount,
  nextMessageCount,
  previousStreamingText,
  nextStreamingText,
}: ShouldAutoScrollMessageListOptions): boolean {
  if (previousSessionId !== nextSessionId) {
    return true;
  }

  if (nextMessageCount > previousMessageCount) {
    return true;
  }

  return nextStreamingText !== previousStreamingText;
}

export function getLunariaScrollbarStyles(
  options: GetLunariaScrollbarStylesOptions = {},
): LunariaScrollbarStyles {
  if (options.hidden) {
    return {
      scrollbarWidth: "none",
      msOverflowStyle: "none",
      "&::-webkit-scrollbar": {
        display: "none",
      },
    };
  }

  return {
    scrollbarWidth: "thin",
    scrollbarColor: "rgba(189, 161, 147, 0.52) transparent",
    "&::-webkit-scrollbar": {
      width: "6px",
    },
    "&::-webkit-scrollbar-track": {
      background: "transparent",
    },
    "&::-webkit-scrollbar-thumb": {
      background: "rgba(189, 161, 147, 0.52)",
      borderRadius: "999px",
    },
    "&::-webkit-scrollbar-thumb:hover": {
      background: "rgba(171, 142, 128, 0.72)",
    },
  };
}
