import { PostHog } from "posthog-node";
import { config } from "../config";
import { logger } from "./logger";
import type { AuthCreditUsageChunk } from "../controllers/v1/types";

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

const client: PostHog | null = config.POSTHOG_API_KEY
  ? new PostHog(config.POSTHOG_API_KEY, {
      host: config.POSTHOG_HOST || "https://us.i.posthog.com",
      flushAt: 20,
      flushInterval: 10_000,
    })
  : null;

// ---------------------------------------------------------------------------
// Pricing-tier helper
// ---------------------------------------------------------------------------

function derivePricingTier(
  acuc: AuthCreditUsageChunk | null | undefined,
): string {
  if (!acuc || !acuc.price_id) return "free";

  const credits = acuc.price_credits ?? 0;
  if (credits <= 500) return "free";
  if (credits <= 8_000) return "hobby";
  if (credits <= 160_000) return "standard";
  if (credits <= 650_000) return "growth";
  return "scale";
}

function deriveMrrBand(acuc: AuthCreditUsageChunk | null | undefined): string {
  const tier = derivePricingTier(acuc);
  switch (tier) {
    case "free":
      return "$0";
    case "hobby":
      return "$0-100";
    case "standard":
      return "$100-500";
    case "growth":
      return "$100-500";
    case "scale":
      return "$500+";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Common properties builder
// ---------------------------------------------------------------------------

interface TeamContext {
  teamId: string;
  acuc?: AuthCreditUsageChunk | null;
}

function commonProperties(ctx: TeamContext): Record<string, unknown> {
  return {
    team_id: ctx.teamId,
    customer_type: "self_serve",
    pricing_tier: derivePricingTier(ctx.acuc),
    mrr_band: deriveMrrBand(ctx.acuc),
    credits_remaining: ctx.acuc?.remaining_credits ?? null,
  };
}

// ---------------------------------------------------------------------------
// Event capture (fire-and-forget, never throws)
// ---------------------------------------------------------------------------

function capture(
  event: string,
  ctx: TeamContext,
  properties: Record<string, unknown> = {},
): void {
  if (!client) return;

  try {
    client.capture({
      distinctId: ctx.teamId,
      event,
      groups: { team: ctx.teamId },
      properties: {
        ...commonProperties(ctx),
        ...properties,
      },
    });
  } catch (err) {
    logger.warn("PostHog capture failed", { event, error: err });
  }
}

// =========================================================================
// 1. API failure & error events
// =========================================================================

export function trackApiRequestFailed(
  ctx: TeamContext,
  props: {
    endpoint: string;
    status_code: number;
    error_type: string;
    error_message: string;
  },
): void {
  capture("api_request_failed", ctx, props);
}

export function trackApiRateLimitHit(
  ctx: TeamContext,
  props: {
    endpoint: string;
    limit_type: "requests" | "tokens" | "concurrency";
  },
): void {
  capture("api_rate_limit_hit", ctx, props);
}

export function trackApiAuthError(
  ctx: TeamContext,
  props: {
    error_type: "invalid_key" | "expired" | "revoked" | "missing";
    endpoint: string;
  },
): void {
  capture("api_auth_error", ctx, props);
}

export function trackApiTimeout(
  ctx: TeamContext,
  props: {
    endpoint: string;
    timeout_ms: number;
  },
): void {
  capture("api_timeout", ctx, props);
}

export function trackApiQuotaExceeded(
  ctx: TeamContext,
  props: {
    quota_type: "credits" | "requests";
    credits_remaining: number;
  },
): void {
  capture("api_quota_exceeded", ctx, props);
}

// =========================================================================
// 2. Credit & billing signals
// =========================================================================

export function trackCreditsDepleted(
  ctx: TeamContext,
  props: {
    credits_used: number;
    days_since_signup?: number;
  },
): void {
  capture("credits_depleted", ctx, props);
}

export function trackCreditsLowThresholdReached(
  ctx: TeamContext,
  props: {
    threshold_pct: number;
    credits_remaining: number;
  },
): void {
  capture("credits_low_threshold_reached", ctx, props);
}

// =========================================================================
// 3. API key lifecycle events
// =========================================================================

export function trackApiKeyFirstUsed(
  ctx: TeamContext,
  props: {
    endpoint: string;
    days_since_creation?: number;
  },
): void {
  capture("api_key_first_used", ctx, props);
}

// =========================================================================
// Shutdown (call on process exit)
// =========================================================================

export async function shutdownPostHog(): Promise<void> {
  if (client) {
    await client.shutdown();
  }
}
