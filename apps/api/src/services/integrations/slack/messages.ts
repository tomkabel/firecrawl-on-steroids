export type MonitorSlackPage = {
  url: string;
  status: string;
  judgment?: {
    meaningful: boolean;
    reason: string;
  } | null;
};

type MonitorSlackPayload = {
  monitorName: string;
  dashboardUrl: string;
  checkId: string;
  summary: {
    changed: number;
    new: number;
    removed: number;
    error: number;
    totalPages: number;
  };
  pages: MonitorSlackPage[];
  creditsUsed: number | null;
};

const MAX_PAGE_BLOCKS = 8;
// Slack caps a section block's `text` at 3000 chars; exceeding it makes the whole
// chat.postMessage fail (invalid_blocks), dropping the alert. URLs are the only
// unbounded input we render, so bound them and clamp the assembled line.
const SECTION_TEXT_LIMIT = 3000;
const MAX_LINK_URL_LEN = 2000;

// Slack mrkdwn requires these three characters escaped in text spans.
export function escapeSlackText(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function slackLink(url: string, label?: string): string {
  // Strip the angle brackets that delimit a link, and percent-encode the pipe:
  // inside `<...>` Slack treats the first `|` as the URL/label separator, so an
  // unescaped `|` in a user-controlled URL can spoof the displayed link text.
  const safeUrl = url.replace(/[<>]/g, "").replace(/\|/g, "%7C");
  if (!label) return `<${safeUrl}>`;
  return `<${safeUrl}|${escapeSlackText(label)}>`;
}

// Renders a page URL for a section: clickable when short enough, otherwise a
// truncated, non-clickable, escaped string so a pathological URL can't blow past
// Slack's section text limit and drop the whole alert.
function boundedPageLink(url: string): string {
  if (url.length <= MAX_LINK_URL_LEN) return slackLink(url);
  return escapeSlackText(truncate(url, MAX_LINK_URL_LEN));
}

// Builds the change-detection alert posted to a channel. Returns both a
// fallback `text` (for notifications/screen readers) and rich Block Kit blocks.
export function buildMonitorAlertMessage(payload: MonitorSlackPayload): {
  text: string;
  blocks: unknown[];
} {
  const { summary } = payload;

  const judged = payload.pages.filter(p => p.judgment);
  const meaningful = judged.filter(p => p.judgment!.meaningful).length;
  const changedLine =
    judged.length > 0
      ? `*Changed:* ${summary.changed} (${meaningful} meaningful)`
      : `*Changed:* ${summary.changed}`;

  const summaryLines = [
    changedLine,
    `*New:* ${summary.new}`,
    `*Removed:* ${summary.removed}`,
    `*Errors:* ${summary.error}`,
    `*Pages checked:* ${summary.totalPages}`,
  ].join("\n");

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🔥 ${truncate(payload.monitorName, 140)}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Your Firecrawl monitor detected activity.\n${summaryLines}`,
      },
    },
  ];

  const sortedPages = [...payload.pages].sort((a, b) => {
    const aM = a.judgment?.meaningful === true ? 0 : 1;
    const bM = b.judgment?.meaningful === true ? 0 : 1;
    return aM - bM;
  });

  const shownPages = sortedPages.slice(0, MAX_PAGE_BLOCKS);
  if (shownPages.length > 0) {
    blocks.push({ type: "divider" });
    for (const page of shownPages) {
      let line = `*${escapeSlackText(page.status)}* ${boundedPageLink(page.url)}`;
      if (page.judgment) {
        line += page.judgment.meaningful
          ? "  :large_orange_diamond: _meaningful_"
          : "  :white_circle: _noise_";
        if (page.judgment.reason) {
          line += `\n_${escapeSlackText(truncate(page.judgment.reason, 240))}_`;
        }
      }
      blocks.push({
        type: "section",
        // Final safety net: never emit a section over Slack's hard limit.
        text: { type: "mrkdwn", text: truncate(line, SECTION_TEXT_LIMIT) },
      });
    }
    const remaining = sortedPages.length - shownPages.length;
    if (remaining > 0) {
      blocks.push({
        type: "context",
        elements: [
          { type: "mrkdwn", text: `…and ${remaining} more page(s).` },
        ],
      });
    }
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "View in dashboard", emoji: true },
        url: payload.dashboardUrl,
        style: "primary",
      },
    ],
  });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Check \`${escapeSlackText(payload.checkId)}\`${
          payload.creditsUsed != null ? ` • ${payload.creditsUsed} credits` : ""
        }`,
      },
    ],
  });

  const text = `Monitor "${payload.monitorName}" detected activity: ${summary.changed} changed, ${summary.new} new, ${summary.removed} removed, ${summary.error} errors.`;

  return { text, blocks };
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return input.slice(0, Math.max(0, max - 1)) + "…";
}
