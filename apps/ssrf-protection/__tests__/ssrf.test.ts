import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Keep `dns/promises` importable but fully mocked so tests never hit the network.
vi.mock("dns/promises", () => ({
  lookup: vi.fn(),
}));

import * as dns from "dns/promises";
const mockLookup = dns.lookup as unknown as ReturnType<typeof vi.fn>;

/**
 * Loads the module with the desired env vars in effect. SSRF_PROTECTION reads
 * ALLOW_LOCAL_WEBHOOKS and DNS_CACHE_TTL_MS once at module-eval time, so env
 * must be set before the (re)import.
 */
async function loadModule() {
  vi.resetModules();
  return import("../src/index");
}

const PUBLIC_IPS = ["8.8.8.8", "1.1.1.1"];

describe("normalizeHostname", () => {
  let mod: typeof import("../src/index");
  beforeEach(async () => {
    mod = await loadModule();
  });

  it("lowercases and strips a single trailing dot", () => {
    expect(mod.normalizeHostname("EXAMPLE.com.")).toBe("example.com");
  });

  it("preserves inner dots and multiple labels", () => {
    expect(mod.normalizeHostname("Foo.Bar.Baz")).toBe("foo.bar.baz");
  });

  it("leaves an already-normal hostname untouched", () => {
    expect(mod.normalizeHostname("example.com")).toBe("example.com");
  });
});

describe("isHttpProtocol", () => {
  let mod: typeof import("../src/index");
  beforeEach(async () => {
    mod = await loadModule();
  });

  it("accepts http and https", () => {
    expect(mod.isHttpProtocol("http:")).toBe(true);
    expect(mod.isHttpProtocol("https:")).toBe(true);
  });

  it("rejects other protocols", () => {
    expect(mod.isHttpProtocol("ftp:")).toBe(false);
    expect(mod.isHttpProtocol("file:")).toBe(false);
    expect(mod.isHttpProtocol("")).toBe(false);
  });
});

describe("isLocalHostname", () => {
  let mod: typeof import("../src/index");
  beforeEach(async () => {
    mod = await loadModule();
  });

  it("matches localhost and *.localhost", () => {
    expect(mod.isLocalHostname("localhost")).toBe(true);
    expect(mod.isLocalHostname("a.localhost")).toBe(true);
  });

  it("does not match ordinary hostnames", () => {
    expect(mod.isLocalHostname("localhost.example.com")).toBe(false);
    expect(mod.isLocalHostname("example.com")).toBe(false);
  });
});

describe("isIPPrivate", () => {
  let mod: typeof import("../src/index");
  beforeEach(async () => {
    mod = await loadModule();
  });

  it("treats RFC1918 and loopback/link-local IPv4 as private", () => {
    expect(mod.isIPPrivate("10.0.0.1")).toBe(true);
    expect(mod.isIPPrivate("172.16.0.1")).toBe(true);
    expect(mod.isIPPrivate("192.168.1.1")).toBe(true);
    expect(mod.isIPPrivate("127.0.0.1")).toBe(true);
    expect(mod.isIPPrivate("169.254.0.1")).toBe(true);
  });

  it("treats public IPv4 as not private", () => {
        expect(mod.isIPPrivate("8.8.8.8")).toBe(false);
        expect(mod.isIPPrivate("1.1.1.1")).toBe(false);
  });

  it("treats IPv6 loopback/unique-local/link-local as private", () => {
    expect(mod.isIPPrivate("::1")).toBe(true);
    expect(mod.isIPPrivate("fc00::1")).toBe(true);
    expect(mod.isIPPrivate("fe80::1")).toBe(true);
  });

  it("treats public IPv6 as not private", () => {
    expect(mod.isIPPrivate("2001:4860:4860::8888")).toBe(false);
  });

  it("returns false for invalid addresses", () => {
    expect(mod.isIPPrivate("not-an-ip")).toBe(false);
    expect(mod.isIPPrivate("999.1.1.1")).toBe(false);
  });
});

describe("lookupWithCache", () => {
  let mod: typeof import("../src/index");
  beforeEach(async () => {
    process.env.DNS_CACHE_TTL_MS = "30000";
    mockLookup.mockReset();
    mod = await loadModule();
  });

  it("returns cached addresses without re-resolving within the TTL", async () => {
    mockLookup.mockResolvedValue(
      PUBLIC_IPS.map((address) => ({ address, family: 4 })),
    );

    const first = await mod.lookupWithCache("example.com");
    const second = await mod.lookupWithCache("example.com");

    expect(first).toEqual(PUBLIC_IPS);
    expect(second).toEqual(PUBLIC_IPS);
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });

  it("deduplicates resolved addresses", async () => {
    mockLookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "8.8.8.8", family: 4 },
    ]);

    const result = await mod.lookupWithCache("dup.example.com");
    expect(result).toEqual(["8.8.8.8"]);
  });

  it("re-resolves after the TTL expires", async () => {
    vi.useFakeTimers();
    process.env.DNS_CACHE_TTL_MS = "1000";
    mod = await loadModule();
    mockLookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);

    await mod.lookupWithCache("ttl.example.com");
    expect(mockLookup).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1500);
    await mod.lookupWithCache("ttl.example.com");
    expect(mockLookup).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});

describe("assertSafeTargetUrl", () => {
  let mod: typeof import("../src/index");
  beforeEach(async () => {
    process.env.ALLOW_LOCAL_WEBHOOKS = "False";
    process.env.DNS_CACHE_TTL_MS = "30000";
    mockLookup.mockReset();
    mod = await loadModule();
  });

  afterEach(() => {
    delete process.env.ALLOW_LOCAL_WEBHOOKS;
    delete process.env.DNS_CACHE_TTL_MS;
  });

  async function expectBlocked(url: string, reasonContains: string) {
    const err = await mod.assertSafeTargetUrl(url).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(mod.InsecureConnectionError);
    // The TS InsecureConnectionError only surfaces `reason` via its message.
    expect((err as Error).message).toContain(reasonContains);
  }

  it("allows a public hostname that resolves to a public IP", async () => {
    mockLookup.mockResolvedValue(PUBLIC_IPS.map((address) => ({ address, family: 4 })));
    await expect(mod.assertSafeTargetUrl("https://example.com/path")).resolves.toBeUndefined();
  });

  it("allows a raw public IP directly", async () => {
    await expect(mod.assertSafeTargetUrl("https://8.8.8.8/")).resolves.toBeUndefined();
  });

  it("throws InsecureConnectionError for an invalid URL", async () => {
    await expectBlocked("not a url", "URL is invalid");
  });

  it("throws for a non-http(s) protocol", async () => {
    await expectBlocked("ftp://example.com/", 'unsupported protocol "ftp:"');
  });

  it("throws for a localhost target", async () => {
    await expectBlocked("http://localhost:8080/", "localhost targets are not allowed");
  });

  it("throws for a raw private IPv4", async () => {
    await expectBlocked("http://10.0.0.1/", 'private IP "10.0.0.1" is not allowed');
  });

  it("throws for a raw private IPv6 (bracketed literal)", async () => {
    await expectBlocked("http://[::1]/", 'private IP "::1" is not allowed');
  });

  it("throws when a hostname resolves to a private IP", async () => {
    mockLookup.mockResolvedValue([{ address: "192.168.0.1", family: 4 }]);
    await expectBlocked(
      "http://internal.example.com/",
      'hostname "internal.example.com" resolves to a private IP',
    );
  });

  it("throws when DNS resolution fails", async () => {
    mockLookup.mockRejectedValue(new Error("EAI_NONAME"));
    await expectBlocked(
      "http://nope.example.com/",
      'DNS lookup failed for "nope.example.com"',
    );
  });

  it("throws when a hostname does not resolve to any address", async () => {
    mockLookup.mockResolvedValue([]);
    await expectBlocked(
      "http://empty.example.com/",
      'hostname "empty.example.com" did not resolve to any IP address',
    );
  });

  it("allows local targets when ALLOW_LOCAL_WEBHOOKS is true", async () => {
    vi.resetModules();
    process.env.ALLOW_LOCAL_WEBHOOKS = "TRUE";
    const bypassMod = await import("../src/index");
    async function expectAllowed(url: string) {
      const err = await bypassMod.assertSafeTargetUrl(url).then(
        () => null,
        (e) => e,
      );
      expect(err).toBeNull();
    }
    await expectAllowed("http://localhost:8080/");
    await expectAllowed("http://10.0.0.1/");
  });
});
