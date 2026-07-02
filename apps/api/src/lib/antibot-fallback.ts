import { config } from "../config";

export interface AntiBotScrapeResponse {
  content: string;
  pageStatusCode: number;
  contentType: string;
  pageError?: string;
}

interface AntiBotBackend {
  name: string;
  url: string;
  authToken?: string;
  detectFailure(html: string, statusCode: number): boolean;
}

function buildAntiBotBackends(): AntiBotBackend[] {
  const backends: AntiBotBackend[] = [];

  if (config.NODRIVER_ADAPTER_URL) {
    backends.push({
      name: "nodriver",
      url: config.NODRIVER_ADAPTER_URL,
      detectFailure: (html, statusCode) =>
        statusCode === 403 ||
        isCaptchaPage(html) ||
        (statusCode === 200 && (html?.trim().length ?? 0) === 0),
    });
  }

  if (config.CHASER_SERVICE_URL) {
    backends.push({
      name: "chaser",
      url: config.CHASER_SERVICE_URL,
      detectFailure: (html, statusCode) =>
        statusCode === 403 ||
        isCaptchaPage(html) ||
        (statusCode === 200 && (html?.trim().length ?? 0) === 0),
    });
  }

  if (config.STEALTH_BROWSER_URL && config.STEALTH_AUTH_TOKEN) {
    backends.push({
      name: "stealth-browser",
      url: config.STEALTH_BROWSER_URL,
      authToken: config.STEALTH_AUTH_TOKEN,
      detectFailure: (html, statusCode) =>
        statusCode === 403 ||
        isCaptchaPage(html) ||
        (statusCode === 200 && (html?.trim().length ?? 0) === 0),
    });
  }

  return backends;
}

function isCaptchaPage(html: string): boolean {
  if (!html) return false;
  const indicators = [
    "cf-challenge-running",
    "challenge-platform",
    "g-recaptcha",
    "turnstile-wrapper",
  ];
  return indicators.some((i) => html.includes(i));
}

function anyBackendDetectedFailure(
  backends: AntiBotBackend[],
  html: string,
  statusCode: number
): boolean {
  return backends.some((b) => b.detectFailure(html, statusCode));
}

export async function tryAntiBotFallback(
  url: string,
  html: string,
  statusCode: number,
  requestOptions: {
    wait_after_load?: number;
    timeout?: number;
    headers?: Record<string, string>;
    check_selector?: string;
    skip_tls_verification?: boolean;
  }
): Promise<AntiBotScrapeResponse | null> {
  const backends = buildAntiBotBackends();

  if (!anyBackendDetectedFailure(backends, html, statusCode)) {
    return null;
  }

  for (const backend of backends) {
    if (!backend.detectFailure(html, statusCode)) continue;

    try {
      const reqHeaders: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (backend.authToken) {
        reqHeaders["Authorization"] = `Bearer ${backend.authToken}`;
      }

      const response = await fetch(backend.url, {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify({
          url,
          wait_after_load: requestOptions.wait_after_load,
          timeout: requestOptions.timeout,
          headers: requestOptions.headers,
          check_selector: requestOptions.check_selector,
          skip_tls_verification: requestOptions.skip_tls_verification,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (response.ok) {
        const result: AntiBotScrapeResponse = await response.json();
        if (result.content && !backend.detectFailure(result.content, result.pageStatusCode)) {
          return result;
        }
      } else {
        console.warn(
          `[antibot-fallback] Backend ${backend.name} returned status ${response.status}`
        );
      }
    } catch (err) {
      console.warn(
        `[antibot-fallback] Backend ${backend.name} failed:`,
        (err as Error).message
      );
    }
  }

  return null;
}
