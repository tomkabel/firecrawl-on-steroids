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

        let (browser, mut handler) =
            Browser::launch(config)
                .await
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

    /// Acquire a concurrency permit. Returns None if the pool is at capacity.
    pub async fn acquire(&self) -> Option<PooledPermit<'_>> {
        let permit = self.semaphore.acquire().await.ok()?;
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
        let page = self
            .browser
            .new_page("about:blank")
            .await
            .map_err(|e| anyhow::anyhow!("Failed to create page: {}", e))?;

        let chaser = ChaserPage::new(page.clone());

        // Apply a randomized profile
        let profile = random_profile();
        chaser.apply_profile(&profile).await?;

        Ok((chaser, page))
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

    let is_linux = std::env::consts::OS == "linux";
    let is_macos = std::env::consts::OS == "macos";

    let builder = if is_macos {
        if rng.gen_bool(0.5) {
            ChaserProfile::macos_arm()
        } else {
            ChaserProfile::macos_intel()
        }
    } else if is_linux {
        ChaserProfile::linux()
    } else {
        ChaserProfile::windows()
    };

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
