/**
 * Headless Browser Tools for LangChain Agent
 * Adapts BrowserTools for headless Puppeteer Page instances
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { Page } from 'puppeteer-core';
import { detectCaptcha, RateLimiter, intelligentElementFilter } from '../agent/utils/AutomationUtils';
import { TIMING } from '../agent/constants';
import { WebsiteAnalyzer } from '../agent/utils/WebsiteAnalyzer';
import { createDocumentTools } from '../agent/tools/DocumentTools';

/**
 * Performance cache for headless browser
 */
class HeadlessPerformanceCache {
  private elementCache: Map<string, { selector: string; timestamp: number }> = new Map();
  private analysisCache: Map<string, { analysis: any; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 30000;

  getElement(description: string, url: string): string | null {
    const key = `${url}:${description}`;
    const cached = this.elementCache.get(key);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.selector;
    }
    return null;
  }

  setElement(description: string, url: string, selector: string): void {
    const key = `${url}:${description}`;
    this.elementCache.set(key, { selector, timestamp: Date.now() });
  }

  getAnalysis(url: string): any | null {
    const cached = this.analysisCache.get(url);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.analysis;
    }
    return null;
  }

  setAnalysis(url: string, analysis: any): void {
    this.analysisCache.set(url, { analysis, timestamp: Date.now() });
  }

  invalidateUrl(url: string): void {
    for (const key of this.elementCache.keys()) {
      if (key.startsWith(url + ':')) {
        this.elementCache.delete(key);
      }
    }
    this.analysisCache.delete(url);
  }
}

/**
 * Dismiss popups in headless browser
 */
async function dismissPopupsHeadless(page: Page): Promise<string> {
  try {
    const cookieDismissed = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"]'));
      const priorityTexts = ['accept all', 'allow all', 'accept all cookies'];

      for (const button of buttons) {
        const text = (button.textContent || '').toLowerCase().trim().replace(/\s+/g, ' ');
        if (text.includes('shop') || text.includes('buy') || text.includes('sign') ||
          text.includes('cart') || text.includes('learn more')) {
          continue;
        }

        if (priorityTexts.some(pt => text === pt || text === pt.replace(' ', ''))) {
          const rect = button.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            (button as HTMLElement).click();
            return `Clicked: "${text}"`;
          }
        }
      }

      const acceptTexts = ['accept', 'agree', 'consent', 'got it', 'ok'];
      for (const button of buttons) {
        const text = (button.textContent || '').toLowerCase().trim().replace(/\s+/g, ' ');
        if (text.length > 30 || text.includes('settings') || text.includes('manage') ||
          text.includes('shop') || text.includes('buy') || text.includes('sign')) {
          continue;
        }

        if (acceptTexts.some(at => text.includes(at))) {
          const rect = button.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.width < 400) {
            (button as HTMLElement).click();
            return `Clicked: "${text}"`;
          }
        }
      }
      return null;
    });

    await page.evaluate(() => {
      document.querySelectorAll('*').forEach(el => {
        const style = window.getComputedStyle(el);
        const zIndex = parseInt(style.zIndex);
        if ((style.position === 'fixed' || style.position === 'absolute') &&
          zIndex > 999 &&
          !el.querySelector('input') &&
          !el.closest('nav') &&
          !el.closest('header')) {
          const rect = el.getBoundingClientRect();
          if (rect.width > window.innerWidth * 0.5 || rect.height > window.innerHeight * 0.5) {
            (el as HTMLElement).style.display = 'none';
          }
        }
      });
    });

    if (cookieDismissed) {
      await new Promise(resolve => setTimeout(resolve, 400));
      return cookieDismissed;
    }

    return 'No cookie popups found';
  } catch (error) {
    return 'No popups';
  }
}

/**
 * Find element by description using vision and DOM analysis
 */
async function findElementByDescriptionHeadless(
  page: Page,
  description: string,
  cache: HeadlessPerformanceCache
): Promise<string> {
  const url = page.url();

  const cached = cache.getElement(description, url);
  if (cached) {
    console.log(`📦 Using cached selector for "${description}": ${cached}`);
    return cached;
  }

  try {
    const elements = await page.evaluate(() => {
      const allElements = Array.from(document.querySelectorAll('button, a, input, select, textarea, [role="button"], [onclick], [class*="btn"], [class*="button"]'));
      return allElements.map((el, idx) => {
        const rect = el.getBoundingClientRect();
        return {
          index: idx,
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().substring(0, 100),
          placeholder: (el as HTMLInputElement).placeholder || '',
          type: (el as HTMLInputElement).type || '',
          id: el.id || '',
          className: el.className || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          visible: rect.width > 0 && rect.height > 0,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        };
      }).filter(el => el.visible);
    });

    if (elements.length === 0) {
      throw new Error(`No interactive elements found on page`);
    }

    const filtered = intelligentElementFilter(elements, description);

    if (filtered.length === 0) {
      throw new Error(`Could not find element matching: "${description}"`);
    }

    const bestMatch = filtered[0];
    const selector = bestMatch.id
      ? `#${bestMatch.id}`
      : bestMatch.className
        ? `.${bestMatch.className.split(' ')[0]}`
        : `${bestMatch.tag}:nth-of-type(${bestMatch.index + 1})`;

    cache.setElement(description, url, selector);
    return selector;
  } catch (error) {
    throw new Error(`Failed to find element "${description}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Create browser tools for headless Puppeteer Page
 */
export function createHeadlessBrowserTools(page: Page) {
  const cache = new HeadlessPerformanceCache();
  const rateLimiter = new RateLimiter(TIMING.ACTION_DELAY);
  const analyzer = new WebsiteAnalyzer();

  return [
    new DynamicStructuredTool({
      name: 'analyze_website',
      description: 'Intelligently analyze the current website to understand its structure, content, and available actions. Use this FIRST when you navigate to a new page.',
      schema: z.object({
        userIntent: z.string().optional().describe('What you want to accomplish (optional)')
      }),
      func: async ({ userIntent }: { userIntent?: string }) => {
        const url = page.url();

        const cached = cache.getAnalysis(url);
        if (cached) {
          console.log(`📦 Using cached analysis for ${url}`);
          return cached;
        }

        await rateLimiter.throttle();
        console.log(`🔍 Analyzing website: ${url}`);

        const analysis = await analyzer.analyze(null as any, page, userIntent);

        cache.setAnalysis(url, analysis);
        return JSON.stringify(analysis, null, 2);
      }
    }),

    new DynamicStructuredTool({
      name: 'navigate',
      description: 'Navigate to a specific URL in the headless browser.',
      schema: z.object({
        url: z.string().describe('The URL to navigate to (must include http:// or https://)')
      }),
      func: async ({ url }: { url: string }) => {
        try {
          await rateLimiter.throttle();
          console.log(`🌐 Navigating to: ${url}`);

          // Wrap page.goto with a hard timeout to prevent indefinite hangs
          const gotoPromise = page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Hard navigation timeout')), 45000)
          );

          await Promise.race([gotoPromise, timeoutPromise]);
          await new Promise(resolve => setTimeout(resolve, TIMING.TAB_SWITCH_DELAY * 2.5));

          cache.invalidateUrl(url);
          const dismissResult = await dismissPopupsHeadless(page);
          const captchaCheck = await detectCaptcha(page);

          if (captchaCheck.hasCaptcha) {
            console.warn(`⚠️  ${captchaCheck.message}`);
            return `⚠️ CAPTCHA DETECTED on ${url}! Type: ${captchaCheck.type}. ${captchaCheck.message}`;
          }

          console.log(`✓ Navigation complete: ${url}`);
          return `Successfully navigated to ${url}. ${dismissResult}`;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ Navigation failed for ${url}: ${errorMsg}`);

          if (errorMsg.includes('timeout')) {
            console.log(`⚠️  Navigation timeout, retrying with networkidle2...`);
            try {
              await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
              await new Promise(resolve => setTimeout(resolve, TIMING.TAB_SWITCH_DELAY * 2.5));
              return `Successfully navigated to ${url} (after retry).`;
            } catch (retryError) {
              return `❌ NAVIGATION TIMEOUT: The website ${url} took too long to load (>30 seconds).`;
            }
          } else if (errorMsg.includes('ERR_CONNECTION_TIMED_OUT')) {
            return `❌ CONNECTION TIMEOUT: Could not connect to ${url}.`;
          } else if (errorMsg.includes('ERR_NAME_NOT_RESOLVED')) {
            return `❌ DNS ERROR: Could not resolve the domain name for ${url}.`;
          } else {
            return `❌ NAVIGATION FAILED: Could not load ${url}\n\nError: ${errorMsg}`;
          }
        }
      }
    }),

    new DynamicStructuredTool({
      name: 'click_element',
      description: 'Click an element on the page by describing what it is (e.g., "search button", "submit form", "login link"). The system will intelligently find the element.',
      schema: z.object({
        description: z.string().describe('Description of the element to click (e.g., "submit button", "login link", "search icon")')
      }),
      func: async ({ description }: { description: string }) => {
        try {
          await rateLimiter.throttle();
          console.log(`🖱️  Clicking: ${description}`);

          // Smart Click Strategy:
          // 1. Try finding by description (Vision/DOM analysis)
          let selector: string;
          try {
            selector = await findElementByDescriptionHeadless(page, description, cache);
          } catch (e) {
            console.warn(`⚠️ Vision/DOM search failed for "${description}", trying text match...`);
            // 2. Fallback: Try finding by text content (XPath)
            const textSelector = `::-p-text(${description})`;
            const found = await page.$(textSelector);
            if (found) {
              selector = textSelector;
            } else {
              throw e; // Re-throw if both fail
            }
          }

          await page.click(selector);
          await new Promise(resolve => setTimeout(resolve, TIMING.ACTION_DELAY));

          console.log(`✓ Clicked: ${description}`);
          return `Successfully clicked "${description}"`;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ Failed to click "${description}": ${errorMsg}`);
          return `❌ Failed to click "${description}": ${errorMsg}`;
        }
      }
    }),

    new DynamicStructuredTool({
      name: 'type_text',
      description: 'Type text into an input field by describing what field it is (e.g., "search box", "email field", "password input").',
      schema: z.object({
        fieldDescription: z.string().describe('Description of the input field (e.g., "search box", "email field")'),
        text: z.string().describe('Text to type'),
        pressEnter: z.boolean().optional().default(false).describe('Whether to press Enter after typing')
      }),
      func: async ({ fieldDescription, text, pressEnter = false }: { fieldDescription: string; text: string; pressEnter?: boolean }) => {
        try {
          await rateLimiter.throttle();
          console.log(`⌨️  Typing into ${fieldDescription}: ${text}`);

          // Smart Type Strategy
          let selector: string;
          try {
            selector = await findElementByDescriptionHeadless(page, fieldDescription, cache);
          } catch (e) {
            console.warn(`⚠️ Vision/DOM search failed for "${fieldDescription}", trying text match...`);
            const textSelector = `::-p-text(${fieldDescription})`;
            const found = await page.$(textSelector);
            if (found) {
              selector = textSelector;
            } else {
              throw e;
            }
          }

          await page.click(selector);

          // Clear field first
          await page.evaluate((sel) => {
            const el = document.querySelector(sel) as HTMLInputElement;
            if (el) el.value = '';
          }, selector);

          await page.type(selector, text, { delay: 100 }); // Slower typing for reliability

          if (pressEnter) {
            await page.keyboard.press('Enter');
            await new Promise(resolve => setTimeout(resolve, TIMING.ACTION_DELAY * 2));
          }

          console.log(`✓ Typed into ${fieldDescription}`);
          return `Successfully typed "${text}" into ${fieldDescription}`;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ Failed to type into "${fieldDescription}": ${errorMsg}`);
          return `❌ Failed to type into "${fieldDescription}": ${errorMsg}`;
        }
      }
    }),

    new DynamicStructuredTool({
      name: 'extract_smart_content',
      description: 'Extract structured content from the current page. Use this to get specific information like prices, headlines, data tables, etc.',
      schema: z.object({
        what: z.string().describe('What to extract (e.g., "all product prices", "article headlines", "stock price", "table data")')
      }),
      func: async ({ what }: { what: string }) => {
        try {
          await rateLimiter.throttle();
          console.log(`📊 Extracting: ${what}`);

          const url = page.url();
          let analysis = cache.getAnalysis(url);

          if (!analysis) {
            console.log(`🔍 Analyzing page for extraction...`);
            analysis = await analyzer.analyze(null as any, page);
            cache.setAnalysis(url, analysis);
          } else {
            console.log(`📦 Using cached analysis for extraction`);
          }

          const extraction = await analyzer.extractContent(page, analysis, what);

          // Truncate content if it's too large
          const contentStr = JSON.stringify(extraction);
          if (contentStr.length > 15000) {
            return contentStr.substring(0, 15000) + '... [TRUNCATED]';
          }

          return JSON.stringify(extraction, null, 2);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ Extraction failed: ${errorMsg}`);
          return `❌ Failed to extract ${what}: ${errorMsg}`;
        }
      }
    }),

    new DynamicStructuredTool({
      name: 'wait_for_element',
      description: 'Wait for an element to appear on the page (useful for dynamic content that loads after page load).',
      schema: z.object({
        description: z.string().describe('Description of the element to wait for'),
        timeoutSeconds: z.number().optional().default(10).describe('Maximum seconds to wait')
      }),
      func: async ({ description, timeoutSeconds = 10 }: { description: string; timeoutSeconds?: number }) => {
        try {
          console.log(`⏳ Waiting for: ${description}`);

          await page.waitForFunction(
            (desc) => {
              const elements = Array.from(document.querySelectorAll('button, a, input, [role="button"]'));
              return elements.some(el => {
                const text = (el.textContent || '').toLowerCase();
                const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
                return text.includes(desc.toLowerCase()) || ariaLabel.includes(desc.toLowerCase());
              });
            },
            { timeout: timeoutSeconds * 1000 },
            description
          );

          console.log(`✓ Element appeared: ${description}`);
          return `Element "${description}" appeared on the page`;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ Timeout waiting for "${description}": ${errorMsg}`);
          return `❌ Timeout: Element "${description}" did not appear within ${timeoutSeconds} seconds`;
        }
      }
    }),

    ...createDocumentTools()
  ];
}

