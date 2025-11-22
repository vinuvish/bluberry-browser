import puppeteer, { Browser, Page } from 'puppeteer-core';
import { app } from 'electron';
import * as path from 'path';

/**
 * Manages a headless Puppeteer browser instance for scheduled tasks
 * Separate from the main browser to avoid UI interference
 */
export class HeadlessBrowserManager {
  private browser: Browser | null = null;
  private isInitialized = false;

  /**
   * Initialize the headless browser
   */
  async initialize(): Promise<void> {
    if (this.isInitialized && this.browser) {
      return;
    }

    try {
      console.log('🤖 Initializing headless browser for scheduled tasks...');

      // Find Chrome/Chromium executable
      const executablePath = this.findChromePath();

      this.browser = await puppeteer.launch({
        headless: true,
        executablePath,
        ignoreHTTPSErrors: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--ignore-certificate-errors',
          '--ignore-ssl-errors',
          '--window-size=1920,1080'
        ],
        defaultViewport: {
          width: 1920,
          height: 1080
        }
      } as any);

      this.isInitialized = true;
      console.log('✅ Headless browser initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize headless browser:', error);
      throw error;
    }
  }

  /**
   * Find Chrome/Chromium executable path
   */
  private findChromePath(): string {
    const platform = process.platform;

    if (platform === 'darwin') {
      // macOS - try multiple locations
      const paths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        path.join(app.getPath('home'), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
      ];

      for (const chromePath of paths) {
        const fs = require('fs');
        if (fs.existsSync(chromePath)) {
          return chromePath;
        }
      }
    } else if (platform === 'win32') {
      // Windows
      return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    } else {
      // Linux
      return '/usr/bin/google-chrome';
    }

    throw new Error('Could not find Chrome/Chromium executable. Please install Chrome.');
  }

  /**
   * Create a new page for task execution
   */
  async createPage(): Promise<Page> {
    // Ensure browser is initialized and connected
    if (!this.browser || !this.browser.isConnected()) {
      console.log('🔄 Browser disconnected or not initialized. Re-initializing...');
      await this.cleanup(); // Clean up old instance if exists
      await this.initialize();
    }

    if (!this.browser) {
      throw new Error('Headless browser not initialized');
    }

    try {
      const page = await this.browser.newPage();

      // Set user agent to avoid bot detection
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      return page;
    } catch (error) {
      console.error('⚠️  Failed to create page, retrying initialization:', error);
      // Retry once
      await this.cleanup();
      await this.initialize();
      if (!this.browser) throw new Error('Failed to recover browser');

      const page = await this.browser.newPage();
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
      return page;
    }
  }

  /**
   * Close a page
   */
  async closePage(page: Page): Promise<void> {
    if (!page.isClosed()) {
      await page.close();
    }
  }

  /**
   * Get browser instance
   */
  getBrowser(): Browser | null {
    return this.browser;
  }

  /**
   * Cleanup - close the browser
   */
  async cleanup(): Promise<void> {
    if (this.browser) {
      console.log('🤖 Closing headless browser...');
      await this.browser.close();
      this.browser = null;
      this.isInitialized = false;
    }
  }
}
