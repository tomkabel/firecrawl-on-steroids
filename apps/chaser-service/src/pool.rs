use chaser_oxide::{Browser, BrowserConfig, ChaserPage, ChaserProfile, Page};
use std::sync::Arc;
use tokio::sync::{Semaphore, SemaphorePermit};

/// Manages a single Chromium browser instance with concurrency-limited page creation.
pub struct BrowserPool {
    browser: Arc<Browser>,
    semaphore: Arc<Semaphore>,
    max_concurrent: usize,
    _handler_handle: tokio::task::JoinHandle<()>,
}

impl BrowserPool {
    /// Launch a Chromium browser and start driving its Handler in the background.
    pub async fn launch(
        max_concurrent: usize,
        chrome_executable: Option<String>,
    ) -> anyhow::Result<Self> {
        let mut config_builder = BrowserConfig::builder()
            .new_headless_mode()
            .no_sandbox()
            .disable_default_args()
            .arg("--disable-dev-shm-usage")
            .arg("--disable-gpu")
            .arg("--disable-accelerated-2d-canvas")
            .arg("--no-zygote")
            .arg("--disable-crashpad-for-testing");

        if let Some(path) = chrome_executable {
            config_builder = config_builder.chrome_executable(path);
        }

        let config = config_builder
            .build()
            .map_err(|e| anyhow::anyhow!("Failed to build browser config: {}", e))?;

        let (browser, mut handler) = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            Browser::launch(config),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Timed out launching browser"))?
        .map_err(|e| anyhow::anyhow!("Failed to launch browser: {}", e))?;

        let browser = Arc::new(browser);

        // Drive the handler in a background task
        let browser_clone = Arc::clone(&browser);
        let handle = tokio::spawn(async move {
            use futures::StreamExt;
            while let Some(_event) = handler.next().await {
                // Keep the handler alive
            }
            tracing::warn!("Browser handler stream ended");
        });

        Ok(Self {
            browser: browser_clone,
            semaphore: Arc::new(Semaphore::new(max_concurrent)),
            max_concurrent,
            _handler_handle: handle,
        })
    }

    /// Acquire a concurrency permit. Returns None immediately (fail-fast) if the
    /// pool is at capacity, rather than blocking and queueing callers.
    pub async fn acquire(&self) -> Option<PooledPermit<'_>> {
        let permit = self.semaphore.try_acquire().ok()?;
        Some(PooledPermit {
            _permit: permit,
            browser: Arc::clone(&self.browser),
        })
    }

    pub fn capacity(&self) -> usize {
        self.semaphore.available_permits()
    }

    pub fn max_capacity(&self) -> usize {
        self.max_concurrent
    }
}

/// A concurrency permit coupled with browser access.
pub struct PooledPermit<'a> {
    _permit: SemaphorePermit<'a>,
    browser: Arc<Browser>,
}

impl PooledPermit<'_> {
    /// Create a new page with a random stealth profile applied.
    pub async fn new_stealth_page(&self) -> anyhow::Result<(ChaserPage, Page)> {
        // Bound the page-creation step so a hung Chromium cannot hold a permit
        // (and starve the rest of the pool) indefinitely.
        let page = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            self.browser.new_page("about:blank"),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Timed out creating page"))?
        .map_err(|e| anyhow::anyhow!("Failed to create page: {}", e))?;

        let chaser = ChaserPage::new(page.clone());

        // Apply a randomized profile. If this fails after the page was created,
        // close the page so we don't leak a browser tab per failure.
        let profile = random_profile();
        match tokio::time::timeout(
            std::time::Duration::from_secs(30),
            chaser.apply_profile(&profile),
        )
        .await
        {
            Ok(Ok(())) => Ok((chaser, page)),
            Ok(Err(e)) => {
                let _ = page.close().await;
                Err(anyhow::anyhow!("Failed to apply stealth profile: {}", e))
            }
            Err(_elapsed) => {
                let _ = page.close().await;
                Err(anyhow::anyhow!("Timed out applying stealth profile"))
            }
        }
    }

    /// Returns the browser reference.
    #[allow(dead_code)]
    pub fn browser(&self) -> &Browser {
        &self.browser
    }
}

/// Generate a random ChaserProfile with realistic variation.
fn random_profile() -> ChaserProfile {
    use rand::Rng;
    let mut rng = rand::thread_rng();

    // This service is built/deployed for Linux only, so `std::env::consts::OS`
    // is always "linux" at runtime — the macOS/Windows branches were unreachable
    // dead code. We always build on the Linux profile base and randomize the
    // remaining fingerprint attributes below.
    let builder = ChaserProfile::linux();

    // Vary Chrome version between 128-132 (realistic spread)
    let chrome_ver: u32 = rng.gen_range(128..=132);

    // Vary memory: 4, 8, or 16 GB
    let mem_options = [4u32, 8, 16];
    let memory = mem_options[rng.gen_range(0..mem_options.len())];

    // Vary CPU cores: 4, 6, 8, 12
    let cpu_options = [4u32, 6, 8, 12];
    let cpu = cpu_options[rng.gen_range(0..cpu_options.len())];

    // Vary screen resolution: 1920x1080 or 2560x1440
    let screen_options = [(1920u32, 1080u32), (2560, 1440)];
    let (sw, sh) = screen_options[rng.gen_range(0..screen_options.len())];

    builder
        .chrome_version(chrome_ver)
        .memory_gb(memory)
        .cpu_cores(cpu)
        .screen(sw, sh)
        .build()
}
