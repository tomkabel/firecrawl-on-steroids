import { describe, it, expect } from "vitest";
import { parseMcpSse } from "../src/mcp";

describe("parseMcpSse", () => {
  it("returns the result payload from a single SSE data line", () => {
    const body = 'data: {"jsonrpc":"2.0","id":1,"result":{"html":"<p>hi</p>"}}\n\n';
    expect(parseMcpSse(body)).toEqual({ html: "<p>hi</p>" });
  });

  it("prefers the first line that carries a result", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"a":2}}\n\n';
    expect(parseMcpSse(body)).toEqual({ a: 1 });
  });

  it("ignores [DONE] and empty data lines", () => {
    const body =
      'data: [DONE]\n\n' +
      'data: \n\n' +
      'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
    expect(parseMcpSse(body)).toEqual({ ok: true });
  });

  it("ignores non-data lines such as event:/id:", () => {
    const body =
      'event: message\n' +
      'id: 1\n' +
      'data: {"jsonrpc":"2.0","id":1,"result":{"v":42}}\n\n';
    expect(parseMcpSse(body)).toEqual({ v: 42 });
  });

  it("skips lines with unparseable JSON and keeps looking", () => {
    const body =
      'data: not-json\n\n' +
      'data: {"jsonrpc":"2.0","id":1,"result":{"recovered":true}}\n\n';
    expect(parseMcpSse(body)).toEqual({ recovered: true });
  });

  it("throws the tool error message when an error object is present", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"boom"}}\n\n';
    expect(() => parseMcpSse(body)).toThrowError("boom");
  });

  it("throws when no valid result line exists", () => {
    const body = 'data: {"jsonrpc":"2.0","id":1,"method":"ping"}\n\n';
    expect(() => parseMcpSse(body)).toThrowError("No valid result in MCP response");
  });

  it("throws on an empty body", () => {
    expect(() => parseMcpSse("")).toThrowError("No valid result in MCP response");
  });
});
