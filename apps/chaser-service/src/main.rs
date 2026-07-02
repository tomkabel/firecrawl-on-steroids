mod pool;
mod ssrf;

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use pool::BrowserPool;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;

// ---- Request/Response types (canonical /scrape contract) ----

#[derive(Debug, Deserialize)]
struct ScrapeRequest {
    url: String,
    #[serde(default)]
    wait_after_load: u64,
    #[serde(default = "default_timeout")]
    timeout: u64,
    #[serde(default)]
    #[allow(dead_code)]
    headers: std::collections::HashMap<String, String>,
    #[serde(default)]
    check_selector: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    skip_tls_verification: bool,
}

fn default_timeout() -> u64 {
    15000
}

#[derive(Debug, Serialize)]
struct ScrapeResponse {
    content: String,
    #[serde(rename = "pageStatusCode")]
    page_status_code: i32,
    #[serde(rename = "contentType")]
    content_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "pageError")]
    page_error: Option<String>,
}

#[derive(Debug, Serialize)]
struct ScrapeError {
    error: String,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: String,
    backend: String,
    #[serde(rename = "activePages")]
    active_pages: usize,
    #[serde(rename = "maxConcurrentPages")]
    max_concurrent_pages: usize,
    uptime: u64,
}

#[derive(Debug, Default, Clone, Serialize)]
struct MetricsCounters {
    success: u64,
    ssrf_blocked: u64,
    error: u64,
}

#[derive(Clone)]
struct AppState {
    pool: Arc<BrowserPool>,
    start_time: Instant,
    metrics: Arc<std::sync::Mutex<MetricsCounters>>,
}

// ---- Routes ----

async fn handle_scrape(
    State(state): State<AppState>,
    Json(req): Json<ScrapeRequest>,
) -> impl IntoResponse {
    // Validation
    if req.url.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ScrapeError {
                error: "URL is required".to_string(),
            }),
        )
            .into_response();
    }

    // SSRF check
    if let Err(e) = ssrf::assert_safe_target_url(&req.url).await {
        {
            let mut m = state.metrics.lock().unwrap();
            m.ssrf_blocked += 1;
        }
        return (
            StatusCode::OK,
            Json(ScrapeResponse {
                content: String::new(),
                page_status_code: 403,
                content_type: "text/plain".to_string(),
                page_error: Some(e.to_string()),
            }),
        )
            .into_response();
    }

    // Acquire a browser pool permit
    let permit = match state.pool.acquire().await {
        Some(p) => p,
        None => {
            let mut m = state.metrics.lock().unwrap();
            m.error += 1;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ScrapeError {
                    error: "Browser pool exhausted".to_string(),
                }),
            )
                .into_response();
        }
    };

    // Create a page with stealth profile
    let (chaser, _page) = match permit.new_stealth_page().await {
        Ok(p) => p,
        Err(e) => {
            let mut m = state.metrics.lock().unwrap();
            m.error += 1;
            tracing::error!("Failed to create stealth page: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ScrapeError {
                    error: "An error occurred while fetching the page.".to_string(),
                }),
            )
                .into_response();
        }
    };

    // Navigate
    let timeout = std::cmp::min(req.timeout, 45000); // cap at 45s
    // tokio::time::timeout — wrap navigation
    let nav_result = tokio::time::timeout(
        std::time::Duration::from_millis(timeout),
        chaser.goto(&req.url),
    )
    .await;

    let (page_status_code, page_error) = match &nav_result {
        Ok(Ok(())) => (200i32, None),
        Ok(Err(e)) => {
            let err_str = e.to_string();
            if err_str.contains("net::") && err_str.contains("ERR_") {
                let status = if err_str.contains("net::ERR_NAME_NOT_RESOLVED") {
                    0
                } else {
                    // Extract status code from Chrome net error if possible
                    err_str
                        .split("net::ERR_")
                        .nth(1)
                        .and_then(|s| s.split_whitespace().next())
                        .map(|_| 0i32)
                        .unwrap_or(0)
                };
                (status, Some(err_str))
            } else {
                (0, Some(err_str))
            }
        }
        Err(_elapsed) => {
            // Timeout
            (0, Some("Request timed out".to_string()))
        }
    };

    // Wait after load
    if req.wait_after_load > 0 && page_status_code == 200 {
        tokio::time::sleep(std::time::Duration::from_millis(req.wait_after_load)).await;
    }

    // Check selector
    if let Some(ref selector) = req.check_selector {
        if page_status_code == 200 {
            let check_result = chaser.evaluate(&format!(
                "!!document.querySelector('{}')",
                selector.replace('\'', "\\'")
            ))
            .await;
            if let Ok(Some(serde_json::Value::Bool(false))) = check_result {
                let mut m = state.metrics.lock().unwrap();
                m.error += 1;
                return (
                    StatusCode::OK,
                    Json(ScrapeResponse {
                        content: String::new(),
                        page_status_code: 0,
                        content_type: "text/plain".to_string(),
                        page_error: Some(format!("Selector not found: {}", selector)),
                    }),
                )
                    .into_response();
            }
        }
    }

    // Get content
    let content = match chaser.content().await {
        Ok(c) => c,
        Err(e) => {
            let mut m = state.metrics.lock().unwrap();
            m.error += 1;
            return (
                StatusCode::OK,
                Json(ScrapeResponse {
                    content: String::new(),
                    page_status_code: 0,
                    content_type: "text/plain".to_string(),
                    page_error: Some(format!("Failed to get page content: {}", e)),
                }),
            )
                .into_response();
        }
    };

    {
        let mut m = state.metrics.lock().unwrap();
        m.success += 1;
    }

    (
        StatusCode::OK,
        Json(ScrapeResponse {
            content,
            page_status_code,
            content_type: "text/html".to_string(),
            page_error,
        }),
    )
        .into_response()
}

async fn handle_health(State(state): State<AppState>) -> impl IntoResponse {
    let active = state.pool.max_capacity() - state.pool.capacity();
    (
        StatusCode::OK,
        Json(HealthResponse {
            status: "healthy".to_string(),
            backend: "chaser-oxide".to_string(),
            active_pages: active,
            max_concurrent_pages: state.pool.max_capacity(),
            uptime: state.start_time.elapsed().as_secs(),
        }),
    )
}

async fn handle_metrics(State(state): State<AppState>) -> impl IntoResponse {
    let m = state.metrics.lock().unwrap().clone();
    let active = state.pool.max_capacity() - state.pool.capacity();

    // Prometheus text format
    let body = format!(
        "scrape_requests_total{{status=\"success\"}} {}\n\
         scrape_requests_total{{status=\"ssrf_blocked\"}} {}\n\
         scrape_requests_total{{status=\"error\"}} {}\n\
         active_pages {}\n",
        m.success, m.ssrf_blocked, m.error, active
    );

    (StatusCode::OK, body)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "chaser_service=info".into()),
        )
        .init();

    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "3000".to_string())
        .parse()
        .unwrap_or(3000);

    let max_concurrent: usize = std::env::var("MAX_CONCURRENT_PAGES")
        .unwrap_or_else(|_| "10".to_string())
        .parse()
        .unwrap_or(10);

    let chrome_path = std::env::var("CHROME_EXECUTABLE").ok();

    tracing::info!(
        port = port,
        max_concurrent = max_concurrent,
        "Starting chaser-service"
    );

    let pool = BrowserPool::launch(max_concurrent, chrome_path).await?;

    let state = AppState {
        pool: Arc::new(pool),
        start_time: Instant::now(),
        metrics: Arc::new(std::sync::Mutex::new(MetricsCounters::default())),
    };

    let app = Router::new()
        .route("/health", get(handle_health))
        .route("/metrics", get(handle_metrics))
        .route("/scrape", post(handle_scrape))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("chaser-service listening on port {}", port);

    axum::serve(listener, app).await?;

    Ok(())
}
