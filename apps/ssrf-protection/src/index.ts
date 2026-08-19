import { lookup } from 'dns/promises';
import { lookup as dnsCallbackLookup, type LookupAddress } from 'dns';
import IPAddr from 'ipaddr.js';

const ALLOW_LOCAL_WEBHOOKS =
  (process.env.ALLOW_LOCAL_WEBHOOKS || 'False').toUpperCase() === 'TRUE';
const DNS_CACHE_TTL_MS = Number.parseInt(
  process.env.DNS_CACHE_TTL_MS || '30000',
  10,
);
// Bound the cache so a hostile/large set of hostnames cannot exhaust memory.
const DNS_CACHE_MAX_ENTRIES = Number.parseInt(
  process.env.DNS_CACHE_MAX_ENTRIES || '5000',
  10,
);

// Short-lived pin of validated IPs per hostname. The proxy re-resolves the
// target at connect time; reusing the exact IPs validated moments earlier
// (and re-checking them) closes the DNS-rebinding window between validation
// and the actual connection.
const DNS_PIN_TTL_MS = Number.parseInt(
  process.env.DNS_PIN_TTL_MS || '2000',
  10,
);

const dnsLookupCache = new Map<
  string,
  { addresses: string[]; expiresAt: number }
>();

// Pinned, validated IPs for a hostname (see DNS_PIN_TTL_MS). Populated by the
// validation functions and consumed by the connect-time DNS lookup so the
// exact verified IP is reused for the connection.
const dnsPinCache = new Map<
  string,
  { addresses: string[]; expiresAt: number }
>();

// Bound a cache so a hostile/large set of distinct hostnames cannot exhaust
// memory. Drop expired entries first (so stale pins don't linger), then evict
// the oldest insertion (Map preserves insertion order, giving a FIFO/LRU bound)
// if still at capacity. Applied to both the validation cache and the shorter
// lived pin cache.
const enforceCacheBound = (
  cache: Map<string, { expiresAt: number }>,
  maxEntries: number,
): void => {
  const now = Date.now();
  for (const [key, value] of cache) {
    if (value.expiresAt <= now) {
      cache.delete(key);
    }
  }
  if (cache.size >= maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
};

export class InsecureConnectionError extends Error {
  constructor(
    public readonly blockedUrl: string,
    reason: string,
  ) {
    super(`Blocked insecure target URL "${blockedUrl}": ${reason}`);
    this.name = 'InsecureConnectionError';
  }
}

export const normalizeHostname = (hostname: string): string =>
  hostname.toLowerCase().replace(/\.$/, '');

export const isHttpProtocol = (protocol: string): boolean =>
  protocol === 'http:' || protocol === 'https:';

export const isIPPrivate = (address: string): boolean => {
  if (!IPAddr.isValid(address)) return false;
  const parsedAddress = IPAddr.parse(address);
  return parsedAddress.range() !== 'unicast';
};

export const isLocalHostname = (hostname: string): boolean =>
  hostname === 'localhost' || hostname.endsWith('.localhost');

export const lookupWithCache = async (hostname: string): Promise<string[]> => {
  const cached = dnsLookupCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.addresses;
  }

  const resolvedAddresses = await lookup(hostname, {
    all: true,
    verbatim: true,
  });
  const uniqueAddresses = [...new Set(resolvedAddresses.map(x => x.address))];

  enforceCacheBound(dnsLookupCache, DNS_CACHE_MAX_ENTRIES);
  dnsLookupCache.set(hostname, {
    addresses: uniqueAddresses,
    expiresAt: Date.now() + DNS_CACHE_TTL_MS,
  });
  return uniqueAddresses;
};

export const assertSafeTargetUrl = async (
  urlString: string,
): Promise<void> => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    throw new InsecureConnectionError(urlString, 'URL is invalid');
  }

  if (!isHttpProtocol(parsedUrl.protocol)) {
    throw new InsecureConnectionError(
      urlString,
      `unsupported protocol "${parsedUrl.protocol}"`,
    );
  }

  if (ALLOW_LOCAL_WEBHOOKS) {
    return;
  }

  const hostname = normalizeHostname(parsedUrl.hostname);
  if (!hostname) {
    throw new InsecureConnectionError(urlString, 'hostname is missing');
  }

  if (isLocalHostname(hostname)) {
    throw new InsecureConnectionError(
      urlString,
      'localhost targets are not allowed',
    );
  }

  if (IPAddr.isValid(hostname)) {
    if (isIPPrivate(hostname)) {
      throw new InsecureConnectionError(
        urlString,
        `private IP "${hostname}" is not allowed`,
      );
    }
    return;
  }

  let resolvedAddresses: string[];
  try {
    resolvedAddresses = await lookupWithCache(hostname);
  } catch {
    throw new InsecureConnectionError(
      urlString,
      `DNS lookup failed for "${hostname}", cannot verify target is safe`,
    );
  }

  if (resolvedAddresses.length === 0) {
    throw new InsecureConnectionError(
      urlString,
      `hostname "${hostname}" did not resolve to any IP address`,
    );
  }

  if (resolvedAddresses.some(address => isIPPrivate(address))) {
    throw new InsecureConnectionError(
      urlString,
      `hostname "${hostname}" resolves to a private IP`,
    );
  }

  // Pin the validated IPs so the connection that follows reuses the exact
  // addresses we just verified (see dnsPinCache / createSafeDnsLookup), which
  // closes the DNS-rebinding window between this check and the actual connect.
  enforceCacheBound(dnsPinCache, DNS_CACHE_MAX_ENTRIES);
  dnsPinCache.set(hostname, {
    addresses: resolvedAddresses,
    expiresAt: Date.now() + DNS_PIN_TTL_MS,
  });
};

// Resolve a hostname and validate it, returning the validated addresses so the
// caller can pin the connection to one of them. Connecting to the validated IP
// (instead of re-resolving at connect time) closes the DNS-rebinding window
// between this check and the actual request.
export const resolveSafeTargetUrl = async (
  urlString: string,
): Promise<string[]> => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    throw new InsecureConnectionError(urlString, 'URL is invalid');
  }

  if (!isHttpProtocol(parsedUrl.protocol)) {
    throw new InsecureConnectionError(
      urlString,
      `unsupported protocol "${parsedUrl.protocol}"`,
    );
  }

  if (ALLOW_LOCAL_WEBHOOKS) {
    // When local webhooks are explicitly allowed, the caller is responsible for
    // the target it connects to.
    return [];
  }

  const hostname = normalizeHostname(parsedUrl.hostname);
  if (!hostname) {
    throw new InsecureConnectionError(urlString, 'hostname is missing');
  }

  if (isLocalHostname(hostname)) {
    throw new InsecureConnectionError(
      urlString,
      'localhost targets are not allowed',
    );
  }

  if (IPAddr.isValid(hostname)) {
    if (isIPPrivate(hostname)) {
      throw new InsecureConnectionError(
        urlString,
        `private IP "${hostname}" is not allowed`,
      );
    }
    return [hostname];
  }

  const resolvedAddresses = await lookupWithCache(hostname);
  if (resolvedAddresses.length === 0) {
    throw new InsecureConnectionError(
      urlString,
      `hostname "${hostname}" did not resolve to any IP address`,
    );
  }

  if (resolvedAddresses.some(address => isIPPrivate(address))) {
    throw new InsecureConnectionError(
      urlString,
      `hostname "${hostname}" resolves to a private IP`,
    );
  }

  // Pin the validated IPs (see dnsPinCache / createSafeDnsLookup) so the
  // connection reuses the exact verified addresses.
  enforceCacheBound(dnsPinCache, DNS_CACHE_MAX_ENTRIES);
  dnsPinCache.set(hostname, {
    addresses: resolvedAddresses,
    expiresAt: Date.now() + DNS_PIN_TTL_MS,
  });

  return resolvedAddresses;
};

const familyOf = (address: string): number =>
  IPAddr.parse(address).kind() === 'ipv6' ? 6 : 4;

// Build a Node-compatible DNS `lookup` function that pins and re-validates the
// resolved IP at connect time. This is the connection-side half of the SSRF
// guard: `assertSafeTargetUrl` validates the hostname up front and records the
// verified IPs in `dnsPinCache`; this lookup reuses those exact IPs (and
// re-checks they are still non-private) when the socket actually connects.
// The original hostname is preserved for SNI/Host, so we only override the
// resolved address — closing the DNS-rebinding gap between validation and
// connection (defense in depth).
export const createSafeDnsLookup = (): typeof import('dns').lookup => {
  const safeLookup = (
    hostname: string,
    options: any,
    callback?: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    const cb =
      typeof options === 'function'
        ? (options as (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void)
        : callback;
    const opts: { family?: number; all?: boolean } =
      typeof options === 'function' ? {} : (options ?? {});

    if (!cb) {
      // The promise-style overload is never used by the proxy's lookup hook.
      return;
    }

    const done = (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => {
      cb(err, address, family);
    };

    if (ALLOW_LOCAL_WEBHOOKS) {
      dnsCallbackLookup(hostname, opts as any, done as any);
      return;
    }

    (async () => {
      const normalized = normalizeHostname(String(hostname));

      if (IPAddr.isValid(normalized)) {
        if (isIPPrivate(normalized)) {
          throw new InsecureConnectionError(
            normalized,
            `private IP "${normalized}" is not allowed`,
          );
        }
        const family = familyOf(normalized);
        return { address: normalized, family };
      }

      const pinned = dnsPinCache.get(normalized);
      let addresses: string[];
      if (pinned && pinned.expiresAt > Date.now()) {
        // Defense in depth: re-validate the pinned IPs right before connecting.
        if (pinned.addresses.some(address => isIPPrivate(address))) {
          dnsPinCache.delete(normalized);
          throw new InsecureConnectionError(
            normalized,
            `hostname "${normalized}" resolves to a private IP`,
          );
        }
        addresses = pinned.addresses;
      } else {
        addresses = await lookupWithCache(normalized);
        if (addresses.length === 0) {
          throw new InsecureConnectionError(
            normalized,
            `hostname "${normalized}" did not resolve to any IP address`,
          );
        }
        if (addresses.some(address => isIPPrivate(address))) {
          throw new InsecureConnectionError(
            normalized,
            `hostname "${normalized}" resolves to a private IP`,
          );
        }
        enforceCacheBound(dnsPinCache, DNS_CACHE_MAX_ENTRIES);
        dnsPinCache.set(normalized, {
          addresses,
          expiresAt: Date.now() + DNS_PIN_TTL_MS,
        });
      }

      // Honor the requested address family when the target offers both.
      let chosen = addresses[0];
      if (opts.family === 4 || opts.family === 6) {
        const preferred = addresses.find(a => familyOf(a) === opts.family);
        if (preferred) chosen = preferred;
      }
      const family = familyOf(chosen);

      if (opts.all) {
        return {
          address: [{ address: chosen, family }] as LookupAddress[],
          family: undefined as unknown as number,
        };
      }
      return { address: chosen, family };
    })().then(
      (result) => {
        if (result) {
          done(null, result.address, result.family);
        }
      },
      (error) => {
        done(
          error instanceof Error ? error : new Error(String(error)),
          '' as unknown as string,
          0,
        );
      },
    );
  };

  return safeLookup as unknown as typeof import('dns').lookup;
};
