use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::net::lookup_host;

/// Matches the TypeScript InsecureConnectionError
#[derive(Debug)]
pub struct SsrfError {
    pub blocked_url: String,
    pub reason: String,
}

impl std::fmt::Display for SsrfError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Blocked insecure target URL \"{}\": {}",
            self.blocked_url, self.reason
        )
    }
}

impl std::error::Error for SsrfError {}

static DNS_CACHE: std::sync::LazyLock<Mutex<HashMap<String, (Vec<IpAddr>, Instant)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

const DNS_CACHE_MAX_ENTRIES: usize = 5000;

fn dns_cache_ttl() -> Duration {
    Duration::from_millis(
        std::env::var("DNS_CACHE_TTL_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(30000),
    )
}

fn allow_local_webhooks() -> bool {
    std::env::var("ALLOW_LOCAL_WEBHOOKS")
        .map(|v| v.to_uppercase() == "TRUE")
        .unwrap_or(false)
}

fn normalize_hostname(hostname: &str) -> String {
    hostname.trim_end_matches('.').to_lowercase()
}

fn is_ip_private(addr: &IpAddr) -> bool {
    match addr {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified() // 0.0.0.0 — routes to localhost on many stacks
                || o[0] == 0 // 0.0.0.0/8 ("this network" block)
                || o == [255, 255, 255, 255] // broadcast
        }
        IpAddr::V6(v6) => {
            // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses
            // embed a v4 address that `is_loopback`/`is_private` etc. do NOT cover on
            // the v6 object, so extract and re-check the embedded v4 to avoid an SSRF
            // bypass.
            if let Some(v4) = ipv4_mapped(v6) {
                return is_ip_private(&IpAddr::V4(v4));
            }
            v6.is_unspecified() // ::
                || v6.is_loopback()
                || is_ipv6_unique_local(v6)
                || is_ipv6_link_local(v6)
        }
    }
}

/// Extract the embedded IPv4 address from an IPv4-mapped (::ffff:a.b.c.d) or
/// IPv4-compatible (::a.b.c.d) IPv6 address, if present.
fn ipv4_mapped(addr: &std::net::Ipv6Addr) -> Option<std::net::Ipv4Addr> {
    let s = addr.segments();
    let is_mapped = s[0] == 0 && s[1] == 0 && s[2] == 0 && s[3] == 0
        && (s[4] == 0 || s[4] == 0xffff);
    if !is_mapped {
        return None;
    }
    let high = s[6];
    let low = s[7];
    Some(std::net::Ipv4Addr::new(
        (high >> 8) as u8,
        (high & 0xff) as u8,
        (low >> 8) as u8,
        (low & 0xff) as u8,
    ))
}

/// Check if an IPv6 address is in the Unique Local Address range (fc00::/7).
fn is_ipv6_unique_local(addr: &std::net::Ipv6Addr) -> bool {
    let segments = addr.segments();
    (segments[0] & 0xfe00) == 0xfc00
}

/// Check if an IPv6 address is in the link-local range (fe80::/10).
fn is_ipv6_link_local(addr: &std::net::Ipv6Addr) -> bool {
    let segments = addr.segments();
    (segments[0] & 0xffc0) == 0xfe80
}

fn is_local_hostname(hostname: &str) -> bool {
    hostname == "localhost" || hostname.ends_with(".localhost")
}

async fn lookup_with_cache(hostname: &str) -> Result<Vec<IpAddr>, SsrfError> {
    {
        let cache = DNS_CACHE.lock().unwrap();
        if let Some((addrs, expires)) = cache.get(hostname) {
            if *expires > Instant::now() {
                return Ok(addrs.clone());
            }
        }
    }

    let mut addrs: Vec<IpAddr> = lookup_host(format!("{}:0", hostname))
        .await
        .map(|iter| iter.map(|sa| sa.ip()).collect())
        .map_err(|_| SsrfError {
            blocked_url: hostname.to_string(),
            reason: format!("DNS lookup failed for \"{}\", cannot verify target is safe", hostname),
        })?;

    addrs.sort();
    addrs.dedup();

    let mut cache = DNS_CACHE.lock().unwrap();
    // Drop expired entries so the cache cannot grow without bound over time.
    cache.retain(|_, (_, expires)| *expires > Instant::now());
    // Bound the cache size: evict an arbitrary stale entry if at capacity.
    if cache.len() >= DNS_CACHE_MAX_ENTRIES {
        if let Some(oldest) = cache.keys().next().cloned() {
            cache.remove(&oldest);
        }
    }
    cache.insert(hostname.to_string(), (addrs.clone(), Instant::now() + dns_cache_ttl()));

    Ok(addrs)
}

/// Validates a target URL against SSRF protection rules.
/// Mirrors the TypeScript `assertSafeTargetUrl` function exactly.
pub async fn assert_safe_target_url(url_string: &str) -> Result<(), SsrfError> {
    let parsed = url::Url::parse(url_string).map_err(|_| SsrfError {
        blocked_url: url_string.to_string(),
        reason: "URL is invalid".to_string(),
    })?;

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(SsrfError {
            blocked_url: url_string.to_string(),
            reason: format!("unsupported protocol \"{}:\"", scheme),
        });
    }

    if allow_local_webhooks() {
        return Ok(());
    }

    let hostname = parsed.host_str().unwrap_or("");
    let hostname = normalize_hostname(hostname);
    if hostname.is_empty() {
        return Err(SsrfError {
            blocked_url: url_string.to_string(),
            reason: "hostname is missing".to_string(),
        });
    }

    if is_local_hostname(&hostname) {
        return Err(SsrfError {
            blocked_url: url_string.to_string(),
            reason: "localhost targets are not allowed".to_string(),
        });
    }

    // Strip RFC 5952 brackets from a literal IPv6 host before IP/DNS checks.
    let bare = hostname
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(&hostname);

    // Check if hostname is already a raw IP
    if let Ok(parsed_ip) = bare.parse::<IpAddr>() {
        if is_ip_private(&parsed_ip) {
            return Err(SsrfError {
                blocked_url: url_string.to_string(),
                reason: format!("private IP \"{}\" is not allowed", parsed_ip),
            });
        }
        return Ok(());
    }

    // DNS resolution
    let resolved = lookup_with_cache(bare).await?;

    if resolved.is_empty() {
        return Err(SsrfError {
            blocked_url: url_string.to_string(),
            reason: format!("hostname \"{}\" did not resolve to any IP address", hostname),
        });
    }

    if resolved.iter().any(|a| is_ip_private(a)) {
        return Err(SsrfError {
            blocked_url: url_string.to_string(),
            reason: format!("hostname \"{}\" resolves to a private IP", hostname),
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_hostname_lowercases_and_strips_trailing_dot() {
        assert_eq!(normalize_hostname("EXAMPLE.com."), "example.com");
        assert_eq!(normalize_hostname("Foo.Bar.Baz"), "foo.bar.baz");
        assert_eq!(normalize_hostname("example.com"), "example.com");
    }

    #[test]
    fn is_ip_private_ipv4() {
        assert!(is_ip_private("10.0.0.1".parse().unwrap()));
        assert!(is_ip_private("172.16.0.1".parse().unwrap()));
        assert!(is_ip_private("192.168.1.1".parse().unwrap()));
        assert!(is_ip_private("127.0.0.1".parse().unwrap()));
        assert!(is_ip_private("169.254.0.1".parse().unwrap()));
        assert!(!is_ip_private("8.8.8.8".parse().unwrap()));
        assert!(!is_ip_private("203.0.113.5".parse().unwrap()));
    }

    #[test]
    fn is_ip_private_ipv6() {
        assert!(is_ip_private("::1".parse().unwrap()));
        assert!(is_ip_private("fc00::1".parse().unwrap()));
        assert!(is_ip_private("fe80::1".parse().unwrap()));
        assert!(!is_ip_private("2001:4860:4860::8888".parse().unwrap()));
    }

    #[test]
    fn is_local_hostname_matches_localhost_and_subdomains() {
        assert!(is_local_hostname("localhost"));
        assert!(is_local_hostname("a.localhost"));
        assert!(!is_local_hostname("localhost.example.com"));
        assert!(!is_local_hostname("example.com"));
    }

    #[test]
    fn ipv6_range_helpers() {
        assert!(is_ipv6_unique_local("fc00::1".parse().unwrap()));
        assert!(is_ipv6_unique_local("fd12:3456::1".parse().unwrap()));
        assert!(!is_ipv6_unique_local("2001:db8::1".parse().unwrap()));

        assert!(is_ipv6_link_local("fe80::1".parse().unwrap()));
        assert!(!is_ipv6_link_local("2001:db8::1".parse().unwrap()));
    }

    #[tokio::test]
    async fn assert_safe_target_url_allows_public_raw_ip() {
        assert!(assert_safe_target_url("https://8.8.8.8/").await.is_ok());
    }

    #[tokio::test]
    async fn assert_safe_target_url_blocks_private_raw_ip() {
        let err = assert_safe_target_url("http://10.0.0.1/")
            .await
            .unwrap_err();
        assert!(err.reason.contains("private IP"));
    }

    #[tokio::test]
    async fn assert_safe_target_url_blocks_private_ipv6() {
        let err = assert_safe_target_url("http://[::1]/")
            .await
            .unwrap_err();
        assert!(err.reason.contains("private IP"));
    }

    #[tokio::test]
    async fn assert_safe_target_url_blocks_unsupported_protocol() {
        let err = assert_safe_target_url("ftp://example.com/")
            .await
            .unwrap_err();
        assert!(err.reason.contains("unsupported protocol"));
    }

    #[tokio::test]
    async fn assert_safe_target_url_blocks_invalid_url() {
        let err = assert_safe_target_url("not a url").await.unwrap_err();
        assert_eq!(err.reason, "URL is invalid");
    }

    #[tokio::test]
    async fn assert_safe_target_url_blocks_missing_hostname() {
        let err = assert_safe_target_url("http:///path").await.unwrap_err();
        assert_eq!(err.reason, "hostname is missing");
    }

    #[tokio::test]
    async fn assert_safe_target_url_blocks_localhost_by_default() {
        let err = assert_safe_target_url("http://localhost:8080/")
            .await
            .unwrap_err();
        assert!(err.reason.contains("localhost"));
    }

    #[tokio::test]
    async fn assert_safe_target_url_allows_local_when_overridden() {
        std::env::set_var("ALLOW_LOCAL_WEBHOOKS", "TRUE");
        assert!(assert_safe_target_url("http://localhost:8080/").await.is_ok());
        assert!(assert_safe_target_url("http://10.0.0.1/").await.is_ok());
        std::env::set_var("ALLOW_LOCAL_WEBHOOKS", "False");
    }
}
