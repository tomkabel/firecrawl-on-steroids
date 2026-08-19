/**
 * Pure, dependency-free anti-bot failure detection helpers.
 *
 * Extracted from `antibot-fallback.ts` so the detection logic can be unit-tested
 * without pulling in the API `config`/networking stack. The behaviour here is
 * intentionally identical to the inline predicates previously used per-backend.
 */

const CAPTCHA_INDICATORS = [
  "cf-challenge-running",
  "challenge-platform",
  "g-recaptcha",
  "turnstile-wrapper",
];

export function isCaptchaPage(html: string | undefined | null): boolean {
  if (!html) return false;
  return CAPTCHA_INDICATORS.some((indicator) => html.includes(indicator));
}

function isEmptyBody(html: string | undefined | null): boolean {
  return !html || html.trim().length === 0;
}

/**
 * Decides whether a scraped response should trigger a fallback to a stealth
 * browser backend. Mirrors the per-backend `detectFailure` predicates used by
 * `tryAntiBotFallback`.
 */
export function detectAntiBotFailure(
  html: string | undefined | null,
  statusCode: number,
): boolean {
  return (
    statusCode === 403 ||
    isCaptchaPage(html) ||
    (statusCode === 200 && isEmptyBody(html))
  );
}
