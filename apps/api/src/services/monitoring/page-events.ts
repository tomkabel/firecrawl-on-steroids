interface PageJudgmentForEvents {
  meaningful: boolean;
}

// Derives the `isMeaningful` payload flag for a `monitor.page` webhook.
// null when the judge didn't run (no goal, no change, etc); otherwise the verdict.
export function derivePageIsMeaningful(
  status: string,
  judgment: PageJudgmentForEvents | null,
): boolean | null {
  if (status !== "changed" || !judgment) return null;
  return judgment.meaningful;
}
