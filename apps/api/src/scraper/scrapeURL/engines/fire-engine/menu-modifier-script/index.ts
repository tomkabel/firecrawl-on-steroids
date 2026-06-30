// In-page capture of per-item modifier/option payloads for the menu format's `modifiers` option.
// Bundled at runtime by getMenuModifierScript() (see ../menuModifierScript.ts) and run as an
// executeJavascript action on a supported store page (the platform is detected by host below).
//
// On the supported platforms an item's customizations are not in the store-page HTML; they load
// from a per-item endpoint. We do not click or interact: every item's request context already lives
// in the page (item links or the embedded feed data), and the per-item endpoint needs only the
// page's own cookies plus a few constant headers. So we build one direct request per item and fire
// them with bounded concurrency, reusing the session. No synthetic click, no captured request.
//
// Returns the `{ type, value }` envelope fire-engine expects; `value` is
// `{ source, items: { [merchantItemId]: rawPayload } }`. The menu-extraction service parses each
// payload into option groups keyed by merchant item id. Best-effort: any failure yields an empty
// `items` map rather than throwing. Unsupported hosts (or pages where item context is not derivable
// in-page) fall closed with no items.
import { ITEM_OPTIONS_QUERY } from "./doordashQuery";

const MAX_ITEMS = 150;
const CONCURRENCY = 8;
const OVERALL_BUDGET_MS = 20000;

type Source = "ubereats" | "doordash" | null;

interface CaptureResult {
  type: "menu-modifiers";
  value: {
    source: Source;
    items: Record<string, unknown>;
    error?: string;
  };
}

interface UberItemContext {
  storeUuid?: string;
  sectionUuid?: string;
  subsectionUuid?: string;
  itemUuid?: string;
  menuItemUuid?: string;
}

export async function captureMenuModifiers(): Promise<CaptureResult> {
  const host = location.hostname;
  if (/(^|\.)ubereats\.com$/.test(host)) {
    return captureUberEats();
  }
  if (/(^|\.)doordash\.com$/.test(host)) {
    return captureDoorDash();
  }
  // host did not match a supported platform
  return { type: "menu-modifiers", value: { source: null, items: {} } };
}

// Runs `task` over each entry of `targets` with bounded concurrency and a hard deadline. The
// AbortController cancels any in-flight fetch when the budget expires; the deadline guard stops
// workers from starting new ones, so nothing runs on after the action returns.
async function runWithBudget<T>(
  targets: T[],
  task: (target: T, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const deadlineAt = Date.now() + OVERALL_BUDGET_MS;
  const budgetTimer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
  }, OVERALL_BUDGET_MS);
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < targets.length && Date.now() < deadlineAt) {
      const target = targets[idx++];
      try {
        await task(target, controller.signal);
      } catch {
        /* ignore (includes the AbortError thrown when the budget expires) */
      }
    }
  };
  const pool: Promise<void>[] = [];
  for (let i = 0; i < Math.min(CONCURRENCY, targets.length); i++) {
    pool.push(worker());
  }
  await Promise.all(pool);
  clearTimeout(budgetTimer);
}

async function captureUberEats(): Promise<CaptureResult> {
  const out: CaptureResult = {
    type: "menu-modifiers",
    value: { source: "ubereats", items: {} },
  };
  try {
    // 1. Collect each item's request context from its `mod=quickView` link. The `modctx` query
    //    param is double URL-encoded JSON carrying the store/section/subsection/item uuids. (The
    //    one `mod=storeInfo` link is naturally skipped: it has no item uuid.)
    const seen = new Set<string>();
    const targets: UberItemContext[] = [];
    document.querySelectorAll('a[href*="mod=quickView"]').forEach(a => {
      try {
        const enc = (a.getAttribute("href") || "").split("modctx=")[1];
        if (!enc) return;
        const ctx = JSON.parse(
          decodeURIComponent(decodeURIComponent(enc.split("&")[0])),
        ) as UberItemContext;
        const uuid = ctx.itemUuid || ctx.menuItemUuid;
        if (uuid && !seen.has(uuid) && targets.length < MAX_ITEMS) {
          seen.add(uuid);
          targets.push(ctx);
        }
      } catch {
        /* ignore */
      }
    });
    if (targets.length === 0) return out;

    // 2. One direct POST per item. The endpoint needs only a constant csrf token plus the page's
    //    own cookies (credentials: include); the body is built from the link context.
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-csrf-token": "x",
    };
    const buildBody = (ctx: UberItemContext): string =>
      JSON.stringify({
        itemRequestType: "ITEM",
        storeUuid: ctx.storeUuid,
        sectionUuid: ctx.sectionUuid,
        subsectionUuid: ctx.subsectionUuid,
        menuItemUuid: ctx.itemUuid || ctx.menuItemUuid,
        isEditFlow: false,
        cbType: "EATER_ENDORSED",
      });

    const results: Record<string, unknown> = {};
    await runWithBudget(targets, async (ctx, signal) => {
      const key = ctx.itemUuid || ctx.menuItemUuid;
      if (!key) return;
      const r = await fetch("/_p/api/getMenuItemV1", {
        method: "POST",
        headers,
        body: buildBody(ctx),
        credentials: "include",
        signal,
      });
      if (r.ok) results[key] = await r.json();
    });
    out.value.items = results;
  } catch (e) {
    out.value.error = String((e as Error)?.message ?? e);
  }
  return out;
}

async function captureDoorDash(): Promise<CaptureResult> {
  const out: CaptureResult = {
    type: "menu-modifiers",
    value: { source: "doordash", items: {} },
  };
  try {
    // 1. The numeric store id is the trailing number of the store slug in the path
    //    (/store/<slug>-<storeId>/<menuId>/...). Without it we cannot build item requests.
    const storeId = (location.pathname.match(/\/store\/[^/]*?-(\d+)(?:\/|$)/) ||
      [])[1];
    if (!storeId) return out;

    // 2. Each menu item is embedded in the server-rendered feed data as a node tagged
    //    `"__typename":"MenuPageItem","id":"<numericId>"`. Collect the unique numeric ids; the few
    //    non-digit characters between the typename and the id are the JSON separators. When the page
    //    loaded without a resolved delivery area the feed carries no items and we fall closed.
    const html = document.documentElement.innerHTML;
    const seen = new Set<string>();
    const itemIds: string[] = [];
    for (const m of html.matchAll(/MenuPageItem\D{1,15}(\d{6,})/g)) {
      const id = m[1];
      if (!seen.has(id) && itemIds.length < MAX_ITEMS) {
        seen.add(id);
        itemIds.push(id);
      }
    }
    if (itemIds.length === 0) return out;

    // 3. One direct POST per item to the per-item endpoint. It accepts the query inline and needs
    //    only the page's cookies (credentials: include) plus the constant client headers below.
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "apollographql-client-name":
        "@doordash/app-consumer-production-ssr-client",
      "apollographql-client-version": "3.0",
      "x-experience-id": "doordash",
      "x-channel-id": "marketplace",
      accept: "*/*",
    };
    const buildBody = (itemId: string): string =>
      JSON.stringify({
        operationName: "itemPage",
        variables: {
          storeId,
          itemId,
          isNested: false,
          fulfillmentType: "Delivery",
        },
        query: ITEM_OPTIONS_QUERY,
      });

    const results: Record<string, unknown> = {};
    await runWithBudget(itemIds, async (itemId, signal) => {
      const r = await fetch("/graphql/itemPage?operation=itemPage", {
        method: "POST",
        headers,
        body: buildBody(itemId),
        credentials: "include",
        signal,
      });
      if (!r.ok) return;
      const json = (await r.json()) as {
        data?: { itemPage?: unknown };
      };
      const itemPage = json?.data?.itemPage;
      if (itemPage) results[itemId] = itemPage;
    });
    out.value.items = results;
  } catch (e) {
    out.value.error = String((e as Error)?.message ?? e);
  }
  return out;
}
