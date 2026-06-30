// In-page capture of per-item modifier/option payloads for the menu format's `modifiers` option.
// Bundled at runtime by getMenuModifierScript() (see ../menuModifierScript.ts) and run as an
// executeJavascript action on a supported store page (the platform is detected by host below).
//
// On a supported platform an item's customizations are not in the store-page HTML; they load from
// a per-item endpoint. We do not click or interact: every item's request context (store / section
// / subsection / item uuids) is already present in the page's item links, and the endpoint only
// needs a constant csrf token plus the page's own cookies. So we build one direct POST per item
// and fire them with bounded concurrency, reusing the session. No synthetic click, no captured
// request.
//
// Returns the `{ type, value }` envelope fire-engine expects; `value` is
// `{ source, items: { [merchantItemId]: rawPayload } }`. The menu-extraction service parses each
// payload into option groups keyed by merchant item id. Best-effort: any failure yields an empty
// `items` map rather than throwing. Unsupported platforms (menus gated, or auth not derivable
// in-page) fall closed with no items.

const MAX_ITEMS = 150;
const CONCURRENCY = 8;
const OVERALL_BUDGET_MS = 20000;

interface CaptureResult {
  type: "menu-modifiers";
  value: {
    source: "ubereats" | null;
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
  const out: CaptureResult = {
    type: "menu-modifiers",
    value: { source: null, items: {} },
  };
  try {
    if (!/(^|\.)ubereats\.com$/.test(location.hostname)) {
      return out; // host did not match a supported platform
    }
    out.value.source = "ubereats";

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

    // 2. One direct POST per item. getMenuItemV1 needs only a constant csrf token plus the page's
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

    // 3. Bounded concurrency with a hard deadline. The AbortController cancels any in-flight fetch
    //    when the budget expires, and the deadline guard stops workers from starting new ones, so
    //    nothing runs on after the action returns.
    const results: Record<string, unknown> = {};
    let idx = 0;
    const controller = new AbortController();
    const deadlineAt = Date.now() + OVERALL_BUDGET_MS;
    const budgetTimer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }, OVERALL_BUDGET_MS);
    const worker = async (): Promise<void> => {
      while (idx < targets.length && Date.now() < deadlineAt) {
        const ctx = targets[idx++];
        const key = ctx.itemUuid || ctx.menuItemUuid;
        if (!key) continue;
        try {
          const r = await fetch("/_p/api/getMenuItemV1", {
            method: "POST",
            headers,
            body: buildBody(ctx),
            credentials: "include",
            signal: controller.signal,
          });
          if (r.ok) results[key] = await r.json();
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
    out.value.items = results;
  } catch (e) {
    out.value.error = String((e as Error)?.message ?? e);
  }
  return out;
}
