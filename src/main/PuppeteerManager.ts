import { app } from "electron";
import pie from "puppeteer-in-electron";
import puppeteer from "puppeteer-core";
import type { Page, CDPSession } from "puppeteer-core";
import { Tab } from "./Tab";
import { retryWithBackoff, isNetworkError } from "./agent/utils/AutomationUtils";
import { TIMING, RETRY_LIMITS, ERROR_PATTERNS, BLOCK_PATTERNS } from "./agent/constants";

/**
 * Manages Puppeteer integration with Electron browser tabs
 * Allows controlling tabs with Puppeteer's API for advanced automation
 */
export class PuppeteerManager {
  private browser: any = null; // Using any to avoid type conflicts between pie and puppeteer-core
  private initialized: boolean = false;
  private pageCache: Map<string, Page> = new Map();
  private cdpSessions: Map<string, CDPSession> = new Map();
  private enableResourceBlocking: boolean = true; // Block images/fonts for 2-3x speedup
  private enableNetworkRetry: boolean = true; // Retry on network errors

  constructor(options?: { enableResourceBlocking?: boolean; enableNetworkRetry?: boolean }) {
    this.enableResourceBlocking = options?.enableResourceBlocking ?? true;
    this.enableNetworkRetry = options?.enableNetworkRetry ?? true;
  }

  /**
   * Initialize puppeteer-in-electron
   * Note: pie.initialize() is called at module load time in index.ts
   * This method just connects the browser
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Connect puppeteer to the Electron app
      // pie.initialize(app) should have already been called at module load time
      this.browser = await pie.connect(app, puppeteer as any);

      this.initialized = true;
      console.log("✅ Puppeteer Manager initialized successfully");
    } catch (error) {
      console.error("Failed to initialize Puppeteer Manager:", error);
      throw error;
    }
  }

  /**
   * Get a Puppeteer Page instance for a given Tab
   * This uses puppeteer-in-electron's getPage method for proper Electron integration
   *
   * @param tab - The Tab instance to get a Puppeteer Page for
   * @returns Puppeteer Page instance
   */
  async getPageForTab(tab: Tab, options?: { skipCache?: boolean }): Promise<Page> {
    if (!this.initialized || !this.browser) {
      throw new Error("PuppeteerManager not initialized. Call initialize() first.");
    }

    // Validate tab and webContents
    if (!tab || !tab.webContents) {
      throw new Error(`Invalid tab: Tab or WebContents is null/undefined`);
    }

    // Check if webContents is destroyed
    if (tab.webContents.isDestroyed()) {
      throw new Error(`Tab ${tab.id} WebContents has been destroyed`);
    }

    // Check if we already have a cached page for this tab
    if (!options?.skipCache && this.pageCache.has(tab.id)) {
      const cachedPage = this.pageCache.get(tab.id)!;
      // Verify the page is still valid
      try {
        if (!cachedPage.isClosed()) {
          // Test if page is responsive
          await cachedPage.evaluate(() => 1);
          return cachedPage;
        }
      } catch (e) {
        // Page is stale, remove from cache
        console.log(`🔄 Removing stale page from cache for tab ${tab.id}`);
        this.pageCache.delete(tab.id);
        this.cdpSessions.delete(tab.id);
      }
    }

    // Retry loop for getting the page
    // Sometimes pie.connect/getPage fails if the webContents isn't fully ready
    let lastError: any;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // Use puppeteer-in-electron's built-in method to get page for WebContentsView
        // puppeteer-in-electron expects BrowserWindow/BrowserView/WebContentsView, not raw WebContents
        // We need to pass the view (WebContentsView) instead of just webContents
        const page = await pie.getPage(this.browser, tab.view as any) as unknown as Page;

        // Set up request interception for performance
        await this.setupRequestInterception(page);

        // Cache the page
        this.pageCache.set(tab.id, page);

        // Clean up cache when page is closed
        page.on('close', () => {
          this.pageCache.delete(tab.id);
          this.cdpSessions.delete(tab.id);
        });

        console.log(`✅ Got Puppeteer page for tab ${tab.id}`);
        return page;
      } catch (error) {
        lastError = error;
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Only retry for specific errors
        if (errorMsg.includes('Unable to find puppeteer Page') && attempt < 3) {
          console.warn(`⚠️  Failed to get Puppeteer page (attempt ${attempt}/3), retrying in 500ms...`);
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }

        // For other errors, throw immediately
        break;
      }
    }

    console.error(`Failed to get Puppeteer page for tab ${tab.id} after retries:`, lastError);

    // Clear cache and throw
    this.pageCache.delete(tab.id);
    this.cdpSessions.delete(tab.id);

    throw new Error(`Could not get Puppeteer page for tab ${tab.id}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }


  /**
   * Set up request interception for performance optimization
   * Blocks unnecessary resources (images, fonts, ads, analytics)
   */
  private async setupRequestInterception(page: Page): Promise<void> {
    if (!this.enableResourceBlocking) {
      return;
    }

    try {
      await page.setRequestInterception(true);

      page.on('request', (request) => {
        const resourceType = request.resourceType();
        const url = request.url();

        // Block images, fonts, media for 2-3x speedup
        if (BLOCK_PATTERNS.RESOURCE_TYPES.includes(resourceType as any)) {
          request.abort();
          return;
        }

        // Block analytics and tracking
        if (BLOCK_PATTERNS.ANALYTICS.some(pattern => url.includes(pattern))) {
          request.abort();
          return;
        }

        // Allow everything else
        request.continue();
      });

      console.log('✅ Request interception enabled for performance');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Only log if it's not the known Fetch.enable protocol error
      if (!errorMsg.includes('Fetch.enable') && !errorMsg.includes("wasn't found")) {
        console.warn('⚠️  Could not enable request interception:', error);
      }
      // Don't throw - this is optional optimization
      // Request interception is not critical for functionality
    }
  }

  /**
   * Invalidate page cache for a specific tab
   */
  invalidateCache(tabId: string): void {
    if (this.pageCache.has(tabId)) {
      console.log(`🔄 Invalidating cache for tab ${tabId}`);
      this.pageCache.delete(tabId);
      this.cdpSessions.delete(tabId);
    }
  }



  /**
   * Click an element using Puppeteer selector with coordinate fallback and network retry
   */
  async clickElement(tab: Tab, selector: string): Promise<void> {
    const clickOperation = async () => {
      return this.executeOnTabWithRetry(tab, async (page) => {
        await page.waitForSelector(selector, { timeout: TIMING.SELECTOR_TIMEOUT });

        try {
          // Strategy 1: Try standard click first (fastest)
          await page.click(selector);
          console.log('✓ Element clicked using standard method');
        } catch (error) {
          console.warn(`⚠️  Standard click failed, trying coordinate-based click...`);

          // Strategy 2: Coordinate-based click (more reliable)
          const element = await page.$(selector);
          if (!element) {
            throw new Error(`Element with selector "${selector}" not found`);
          }

          const box = await element.boundingBox();
          if (!box) {
            throw new Error(`Element "${selector}" has no bounding box (might be hidden)`);
          }

          // Click at center of element
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;

          console.log(`🎯 Clicking at coordinates (${x.toFixed(0)}, ${y.toFixed(0)})`);
          await page.mouse.click(x, y);
          console.log('✓ Element clicked using coordinate-based method');
        }
      });
    };

    // Retry on network errors if enabled
    if (this.enableNetworkRetry) {
      return retryWithBackoff(clickOperation, {
        maxRetries: RETRY_LIMITS.NETWORK_ERROR_RETRIES,
        initialDelay: TIMING.ACTION_DELAY,
        retryOn: isNetworkError
      });
    } else {
      return clickOperation();
    }
  }

  /**
   * Execute a Puppeteer script on a tab with automatic retry for stale connections
   */
  async executeOnTabWithRetry<T>(
    tab: Tab,
    script: (page: Page) => Promise<T>,
    maxRetries: number = RETRY_LIMITS.STALE_CONNECTION_RETRIES
  ): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const page = await this.getPageForTab(tab, { skipCache: attempt > 1 });
        return await script(page);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Check if error is due to stale connection
        const isStaleConnection = ERROR_PATTERNS.STALE_CONNECTION.some(pattern =>
          errorMsg.includes(pattern)
        );

        if (isStaleConnection && attempt < maxRetries) {
          console.warn(`⚠️  Stale Puppeteer connection, retrying (${attempt}/${maxRetries})...`);
          // Invalidate cache to force fresh connection
          this.invalidateCache(tab.id);
          // Brief delay before retry
          await new Promise(resolve => setTimeout(resolve, TIMING.STALE_CONNECTION_RETRY_DELAY));
          continue;
        }

        // Not a stale connection error, or out of retries
        throw error;
      }
    }
    throw new Error('executeOnTabWithRetry: Should not reach here');
  }


  /**
   * Wait for an element to appear
   */
  async waitForElement(
    tab: Tab,
    selector: string,
    options?: { timeout?: number; visible?: boolean }
  ): Promise<void> {
    return this.executeOnTabWithRetry(tab, async (page) => {
      await page.waitForSelector(selector, options);
    });
  }

  /**
   * Check if the manager is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the browser instance (for advanced use cases)
   */
  getBrowser(): any {
    return this.browser;
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    // Clear page cache
    this.pageCache.clear();

    // Note: We don't disconnect the browser as it's tied to the Electron app lifecycle
    this.initialized = false;
  }
}

