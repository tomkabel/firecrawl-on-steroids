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
        IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        // Stable alternative for is_global: check that it's NOT a known-private type.
        // Private IPv6 ranges: loopback (::1), unique local (fc00::/7), link-local (fe80::/10)
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || is_ipv6_unique_local(v6)
                || is_ipv6_link_local(v6)
        },
    }
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

    // Check if hostname is already a raw IP
    if let Ok(parsed_ip) = hostname.parse::<IpAddr>() {
        if is_ip_private(&parsed_ip) {
            return Err(SsrfError {
                blocked_url: url_string.to_string(),
                reason: format!("private IP \"{}\" is not allowed", parsed_ip),
            });
        }
        return Ok(());
    }

    // DNS resolution
    let resolved = lookup_with_cache(&hostname).await?;

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
