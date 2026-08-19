export interface MCPResult {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Parses a FastMCP HTTP (SSE) transport body of the form:
 *   data: {...}\n\n
 * and returns the first `result` payload found. Throws if a tool-level error is
 * encountered, or if no valid result line is present.
 *
 * This is the pure parsing logic extracted from `mcpCall` in `index.ts` so it
 * can be unit-tested without performing network requests.
 */
export function parseMcpSse(text: string): unknown {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;

    const raw = line.slice(6).trim();
    if (!raw || raw === "[DONE]") continue;

    try {
      const parsed = JSON.parse(raw) as MCPResult;
      if (parsed.result !== undefined) return parsed.result;
      if (parsed.error) {
        throw new Error(parsed.error.message || JSON.stringify(parsed.error));
      }
    } catch (e) {
      if (e instanceof SyntaxError) continue;
      throw e;
    }
  }

  throw new Error("No valid result in MCP response");
}
