/**
 * Browser Tools for LangChain Agent
 * Wraps Puppeteer operations as LangChain tools with vision-based element detection
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { ChatOpenAI } from '@langchain/openai';
import type { Window } from '../../Window';
import type { Tab } from '../../Tab';
import type { Page } from 'puppeteer-core';
import { detectCaptcha, RateLimiter, intelligentElementFilter } from '../utils/AutomationUtils';
import { TIMING, CONTENT_LIMITS, MODELS } from '../constants';
import { WebsiteAnalyzer } from '../utils/WebsiteAnalyzer';
import { createDocumentTools } from './DocumentTools';

/**
 * Performance cache for element finding and page analysis
 */
class PerformanceCache {
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

  clear(): void {
    this.elementCache.clear();
    this.analysisCache.clear();
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
 * Automatically dismiss common popups (cookie dialogs, notifications, etc.)
 */
async function dismissPopups(page: Page): Promise<string> {
  try {
    console.log('🔍 Aggressively dismissing popups and overlays...');

    const urlBefore = page.url();
    const currentDomain = new URL(urlBefore).hostname;

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
            console.log(`🍪 Clicking priority button: "${text}"`);
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
            console.log(`🍪 Clicking accept button: "${text}"`);
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

      const overlaySelectors = [
        '[class*="overlay"]', '[class*="modal"]', '[class*="popup"]',
        '[class*="backdrop"]', '[id*="overlay"]', '[id*="modal"]'
      ];
      overlaySelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width > window.innerWidth * 0.5 || rect.height > window.innerHeight * 0.5) {
            (el as HTMLElement).style.display = 'none';
          }
        });
      });
    });

    if (cookieDismissed) {
      console.log(`✅ ${cookieDismissed}`);
      await new Promise(resolve => setTimeout(resolve, 400));

      const urlAfter = page.url();
      if (!urlAfter.includes(currentDomain)) {
        console.warn(`⚠️  Popup click caused unwanted navigation! Before: ${urlBefore}, After: ${urlAfter}`);
      }

      return cookieDismissed;
    }

    return 'No cookie popups found';
  } catch (error) {
    return 'No popups';
  }
}

export function createBrowserTools(window: Window, specificTab?: Tab, onTabCreated?: (tab: Tab) => void) {
  const cache = new PerformanceCache();

  const getActiveTab = async () => {
    const tab = specificTab || window.activeTab;
    if (!tab) {
      throw new Error('No active tab');
    }

    if (specificTab && window.activeTab?.id !== specificTab.id) {
      console.log(`🔄 Auto-switching to tab ${specificTab.id} for automation`);
      window.switchActiveTab(specificTab.id);
      await new Promise(resolve => setTimeout(resolve, TIMING.TAB_SWITCH_DELAY));
    }

    return tab;
  };

  const puppeteer = window.puppeteerManager;
  const rateLimiter = new RateLimiter(TIMING.ACTION_DELAY);
  const analyzer = new WebsiteAnalyzer();

  return [
    new DynamicStructuredTool({
      name: 'analyze_website',
      description: 'Intelligently analyze the current website to understand its structure, content, and available actions. Use this FIRST when you navigate to a new page to understand what you can do. Returns page type, main content, available actions, and suggestions for next steps.',
      schema: z.object({
        userIntent: z.string().optional().describe('What you want to accomplish (optional, helps focus the analysis)')
      }),
      func: async ({ userIntent }: { userIntent?: string }) => {
        let tab;
        try {
          tab = await getActiveTab();

          if (!puppeteer) {
            return 'ERROR: Puppeteer manager not available. Cannot analyze website.';
          }

          const page = await puppeteer.getPageForTab(tab);
          if (!page) {
            return 'ERROR: Could not get Puppeteer page for tab. The page may not be loaded yet.';
          }
          await rateLimiter.throttle();

          // Wait a moment for page to stabilize
          await new Promise(resolve => setTimeout(resolve, 500));

          const cachedAnalysis = cache.getAnalysis(tab.url);
          if (cachedAnalysis && !userIntent) {
            console.log('📦 Using cached website analysis');
            // If cached is a string, return it; if it's an object, stringify it
            return typeof cachedAnalysis === 'string' ? cachedAnalysis : JSON.stringify(cachedAnalysis, null, 2);
          }

          console.log(`🔍 Analyzing website: ${tab.url}`);
          const analysis = await analyzer.analyze(tab, page, userIntent);

          const result = JSON.stringify({
            pageType: analysis.pageType,
            confidence: `${Math.round(analysis.confidence * 100)}%`,
            mainContent: analysis.mainContent,
            availableActions: {
              buttons: analysis.actions.buttons.slice(0, 5),
              forms: analysis.actions.forms,
              importantLinks: analysis.actions.links.slice(0, 5),
            },
            nextSteps: analysis.suggestions.nextSteps,
            relevantAreas: analysis.suggestions.relevantAreas,
            structuredData: analysis.structuredData ? 'Available' : 'None',
          }, null, 2);

          // Store the analysis object (not the stringified result) for extract_smart_content to use
          cache.setAnalysis(tab.url, analysis);
          console.log(`✅ Website analysis complete: ${analysis.pageType}`);

          return result;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ Error analyzing website: ${errorMsg}`);

          // Return a basic analysis instead of error to prevent tool from being marked as failed
          return JSON.stringify({
            pageType: 'unknown',
            confidence: '0%',
            mainContent: {
              title: tab?.title || 'Unknown',
              description: 'Unable to analyze page fully',
              keyPoints: ['Page analysis encountered an error'],
            },
            availableActions: {
              buttons: [],
              forms: [],
              importantLinks: [],
            },
            nextSteps: ['Try navigating to the page again', 'Check if page loaded correctly'],
            relevantAreas: [],
            structuredData: 'None',
            error: errorMsg,
          }, null, 2);
        }
      }
    }),

    new DynamicStructuredTool({
      name: 'extract_smart_content',
      description: 'Intelligently extract specific content from the page based on what you need. Understands page structure and returns structured data. Better than extract_data for complex information.',
      schema: z.object({
        what: z.string().describe('What information to extract (e.g., "product price and reviews", "article main points", "company contact info")')
      }),
      func: async ({ what }: { what: string }) => {
        try {
          const tab = await getActiveTab();
          const page = await puppeteer.getPageForTab(tab);

          // Check cache first
          let analysis = cache.getAnalysis(tab.url);
          if (!analysis) {
            console.log(`🔍 Analyzing website for extraction: ${tab.url}`);
            analysis = await analyzer.analyze(tab, page, what);
            cache.setAnalysis(tab.url, analysis);
          } else {
            console.log(`📦 Using cached analysis for extraction`);
          }

          // Validate analysis structure - ensure mainContent exists
          if (!analysis || typeof analysis !== 'object') {
            console.warn('⚠️  Invalid analysis, re-analyzing...');
            analysis = await analyzer.analyze(tab, page, what);
            cache.setAnalysis(tab.url, analysis);
          }

          // Ensure mainContent exists with proper structure
          if (!analysis.mainContent) {
            console.warn('⚠️  Analysis missing mainContent, re-analyzing...');
            analysis = await analyzer.analyze(tab, page, what);
            cache.setAnalysis(tab.url, analysis);
          }

          // Ensure mainContent has required fields
          if (!analysis.mainContent.title) {
            analysis.mainContent.title = 'Unknown';
          }
          if (!analysis.mainContent.keyPoints) {
            analysis.mainContent.keyPoints = [];
          }
          if (!analysis.mainContent.data) {
            analysis.mainContent.data = {};
          }

          const content = await analyzer.extractContent(page, analysis, what);

          // Truncate content if it's too large to prevent token limits
          const contentStr = JSON.stringify(content);
          const truncatedContent = contentStr.length > 15000
            ? JSON.parse(contentStr.substring(0, 15000) + '... [TRUNCATED]')
            : content;

          return JSON.stringify({
            pageType: analysis.pageType || 'unknown',
            extracted: truncatedContent,
            source: {
              url: tab.url,
              title: analysis.mainContent?.title || 'Unknown',
            }
          }, null, 2);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ Error in extract_smart_content: ${errorMsg}`);
          return `ERROR extracting content: ${errorMsg}`;
        }
      }
    }),

    new DynamicStructuredTool({
      name: 'list_tabs',
      description: 'List all open browser tabs with their IDs, titles, and URLs. Use this to see what tabs are available before switching or to work with multiple tabs.',
      schema: z.object({}),
      func: async () => {
        const allTabs = window.allTabs;
        const activeTab = window.activeTab;

        const tabList = allTabs.map(tab => ({
          id: tab.id,
          title: tab.title || 'Untitled',
          url: tab.url || 'about:blank',
          isActive: tab.id === activeTab?.id
        }));

        return JSON.stringify({
          totalTabs: tabList.length,
          activeTabId: activeTab?.id || null,
          tabs: tabList
        }, null, 2);
      }
    }),

    new DynamicStructuredTool({
      name: 'switch_to_tab',
      description: 'Switch to a different browser tab by its ID. Use list_tabs first to see available tabs. After switching, all subsequent actions will operate on the new active tab.',
      schema: z.object({
        tabId: z.string().describe('The ID of the tab to switch to (get from list_tabs)')
      }),
      func: async ({ tabId }: { tabId: string }) => {
        const success = window.switchActiveTab(tabId);

        if (!success) {
          return `ERROR: Could not switch to tab "${tabId}". Tab not found. Use list_tabs to see available tabs.`;
        }

        const tab = window.getTab(tabId);
        if (!tab) {
          return `ERROR: Tab "${tabId}" not found after switching.`;
        }

        await new Promise(resolve => setTimeout(resolve, 500));

        return `✅ Successfully switched to tab "${tabId}" (${tab.title || 'Untitled'} - ${tab.url})`;
      }
    }),

    new DynamicStructuredTool({
      name: 'navigate',
      description: 'Navigate to a specific URL in the current active tab. To navigate in a different tab, use switch_to_tab first.',
      schema: z.object({
        url: z.string().describe('The URL to navigate to (must include http:// or https://)')
      }),
      func: async ({ url }: { url: string }) => {
        let tab;
        try {
          await rateLimiter.throttle();

          console.log(`🌐 Navigating to: ${url}`);
          tab = await getActiveTab();

          // Wrap loadURL with a hard timeout to prevent indefinite hangs
          const loadPromise = tab.loadURL(url);
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Hard navigation timeout')), 45000)
          );

          await Promise.race([loadPromise, timeoutPromise]);
          await new Promise(resolve => setTimeout(resolve, TIMING.TAB_SWITCH_DELAY * 2.5));

          const page = await puppeteer.getPageForTab(tab);
          const dismissResult = await dismissPopups(page);
          const captchaCheck = await detectCaptcha(page);
          if (captchaCheck.hasCaptcha) {
            console.warn(`⚠️  ${captchaCheck.message}`);
            return `⚠️ CAPTCHA DETECTED on ${url}! Type: ${captchaCheck.type}. ${captchaCheck.message}. Automation cannot proceed past CAPTCHA. You may need to solve it manually or try a different approach.`;
          }

          console.log(`✓ Navigation complete: ${url}`);
          return `Successfully navigated to ${url}. ${dismissResult}`;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ Navigation failed for ${url}: ${errorMsg}`);

          if (errorMsg.includes('timeout') && tab) {
            console.log(`⚠️  Navigation timeout, retrying with networkidle2...`);
            try {
              await tab.loadURL(url); // Retry
              await new Promise(resolve => setTimeout(resolve, TIMING.TAB_SWITCH_DELAY * 2.5));
              return `Successfully navigated to ${url} (after retry).`;
            } catch (retryError) {
              return `❌ NAVIGATION TIMEOUT: The website ${url} took too long to load (>30 seconds). This could mean:\n- The website is very slow or down\n- The website is blocking automated browsers\n- Network connection issues\n\nSuggestions:\n- Try again later\n- Check if the website is accessible manually\n- Try a different URL`;
            }
          } else if (errorMsg.includes('ERR_CONNECTION_TIMED_OUT') || errorMsg.includes('ERR_TIMED_OUT')) {
            return `❌ CONNECTION TIMEOUT: Could not connect to ${url}. This could mean:\n- The website is down or unreachable\n- DNS resolution failed\n- Network connectivity issues\n- The website is blocking your IP\n\nSuggestions:\n- Verify the URL is correct\n- Check if the website is accessible in a regular browser\n- Try again in a few minutes`;
          } else if (errorMsg.includes('ERR_NAME_NOT_RESOLVED') || errorMsg.includes('DNS')) {
            return `❌ DNS ERROR: Could not resolve the domain name for ${url}. The website address might be incorrect or the domain doesn't exist.\n\nSuggestions:\n- Double-check the URL spelling\n- Verify the domain exists\n- Try accessing the website manually`;
          } else if (errorMsg.includes('ERR_INTERNET_DISCONNECTED')) {
            return `❌ NO INTERNET: Your device appears to be disconnected from the internet. Please check your network connection and try again.`;
          } else if (errorMsg.includes('ERR_CONNECTION_REFUSED')) {
            return `❌ CONNECTION REFUSED: The server at ${url} refused the connection. The website might be down or blocking automated access.`;
          } else if (errorMsg.includes('ERR_ABORTED') || errorMsg.includes('-3')) {
            return `ℹ️ Navigation to ${url} was aborted (possibly redirected or cancelled). This is usually not an error.`;
          } else {
            return `❌ NAVIGATION FAILED: Could not load ${url}\n\nError: ${errorMsg}\n\nSuggestions:\n- Verify the URL is correct and accessible\n- Try again in a few moments\n- Check if the website requires login or special access`;
          }
        }
      }
    }),

    new DynamicStructuredTool({
      name: 'observe_page',
      description: 'Extract visible text from current page. Use this to understand what is on the page.',
      schema: z.object({}),
      func: async () => {
        try {
          const tab = await getActiveTab();
          const text = await tab.getTabText();
          const url = tab.url;

          const page = await puppeteer.getPageForTab(tab);
          const captchaCheck = await detectCaptcha(page);

          return JSON.stringify({
            url,
            text: text?.substring(0, 1500) || '',
            status: 'Page loaded successfully',
            captcha: captchaCheck.hasCaptcha ? `⚠️ CAPTCHA DETECTED: ${captchaCheck.type}` : 'No CAPTCHA detected',
            timestamp: new Date().toISOString()
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ Failed to observe page: ${errorMsg}`);
          return JSON.stringify({
            url: 'unknown',
            text: '',
            status: `ERROR: Could not observe page - ${errorMsg}`,
            captcha: 'Unknown',
            timestamp: new Date().toISOString()
          });
        }
      }
    }),

    new DynamicStructuredTool({
      name: 'click_element',
      description: 'Click an element on the page by describing what it looks like. Examples: "Login button", "Search icon", "Submit form button"',
      schema: z.object({
        description: z.string().describe('Natural language description of the element to click')
      }),
      func: async ({ description }: { description: string }) => {
        try {
          await rateLimiter.throttle();

          console.log(`🖱️  Attempting to click: "${description}"`);
          const tab = await getActiveTab();

          const page = await puppeteer.getPageForTab(tab);
          await dismissPopups(page);

          const urlBefore = tab.url;
          const textBefore = (await tab.getTabText())?.substring(0, 500) || '';

          const cachedSelector = cache.getElement(description, tab.url);
          let selector: string;

          if (cachedSelector) {
            console.log(`📦 Using cached selector for: "${description}"`);
            selector = cachedSelector;
          } else {
            // Smart Click Strategy:
            // 1. Try finding by description (Vision/DOM analysis)
            try {
              selector = await findElementByDescription(tab, description, puppeteer);
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
            cache.setElement(description, tab.url, selector);
          }

          console.log(`✅ Element found, clicking now...`);
          await puppeteer.clickElement(tab, selector);
          await new Promise(resolve => setTimeout(resolve, TIMING.CLICK_WAIT));

          const urlAfter = tab.url;
          const textAfter = (await tab.getTabText())?.substring(0, 500) || '';

          const urlChanged = urlBefore !== urlAfter;
          const contentChanged = textBefore !== textAfter;

          if (urlChanged) {
            cache.invalidateUrl(urlBefore);
            console.log(`✓ Click worked! Page navigated from ${urlBefore} to ${urlAfter}`);
            return `Successfully clicked "${description}" - page navigated to ${urlAfter}`;
          } else if (contentChanged) {
            cache.invalidateUrl(tab.url);
            console.log(`✓ Click worked! Page content changed`);
            return `Successfully clicked "${description}" - page content updated (no navigation)`;
          } else {
            console.warn(`⚠️  Click executed but page didn't change - might be a modal or no-op`);
            return `Clicked "${description}" but page didn't visibly change. The element might not be interactive or the action is subtle.`;
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ Failed to click "${description}": ${errorMsg}`);

          // Return helpful error info instead of just "ERROR" to help agent retry with better description
          return JSON.stringify({
            success: false,
            error: `Could not find or click "${description}"`,
            suggestion: `Try describing the element more specifically. For example: "the ${description} button" or "the ${description} link"`,
            details: errorMsg,
            nextSteps: [
              'Try using a more specific description',
              'Check if the element is visible on the page',
              'Use analyze_website() to see available elements'
            ]
          }, null, 2);
        }
      }
    }),

    new DynamicStructuredTool({
      name: 'type_text',
      description: 'Type text into an input field. For search boxes, this will automatically press Enter to submit. Describe the input field naturally.',
      schema: z.object({
        fieldDescription: z.string().describe('Description of the input field (e.g., "email input", "search box")'),
        text: z.string().describe('The text to type'),
        pressEnter: z.boolean().optional().default(true).describe('Whether to press Enter after typing (default: true for search boxes)')
      }),
      func: async ({ fieldDescription, text, pressEnter = true }: { fieldDescription: string; text: string; pressEnter?: boolean }) => {
        try {
          console.log(`⌨️  Typing into: "${fieldDescription}"`);
          const tab = await getActiveTab();
          const cachedSelector = cache.getElement(fieldDescription, tab.url);
          let selector: string;

          if (cachedSelector) {
            console.log(`📦 Using cached selector for field: "${fieldDescription}"`);
            selector = cachedSelector;
          } else {
            selector = await findElementByDescription(tab, fieldDescription, puppeteer);
            cache.setElement(fieldDescription, tab.url, selector);
          }

          const page = await puppeteer.getPageForTab(tab);
          await dismissPopups(page);

          const urlBefore = tab.url;

          console.log(`🖱️  Clicking field to activate it...`);
          await puppeteer.clickElement(tab, selector);
          await new Promise(resolve => setTimeout(resolve, TIMING.POPUP_DISMISS_DELAY));

          await page.evaluate((sel) => {
            const element = document.querySelector(sel) as HTMLInputElement;
            if (element) {
              element.focus();
              element.value = '';
              element.dispatchEvent(new Event('input', { bubbles: true }));
              element.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, selector);

          for (const char of text) {
            await page.evaluate((sel, character) => {
              const element = document.querySelector(sel) as HTMLInputElement;
              if (element) {
                element.value += character;
                element.dispatchEvent(new KeyboardEvent('keydown', { key: character, bubbles: true }));
                element.dispatchEvent(new KeyboardEvent('keypress', { key: character, bubbles: true }));
                element.dispatchEvent(new Event('input', { bubbles: true }));
                element.dispatchEvent(new KeyboardEvent('keyup', { key: character, bubbles: true }));
              }
            }, selector, char);

            // Randomize typing delay for human-like behavior (50ms - 150ms)
            const randomDelay = Math.floor(Math.random() * 100) + 50;
            await new Promise(resolve => setTimeout(resolve, randomDelay));
          }

          await page.evaluate((sel) => {
            const element = document.querySelector(sel) as HTMLInputElement;
            if (element) {
              element.dispatchEvent(new Event('change', { bubbles: true }));
              element.dispatchEvent(new Event('blur', { bubbles: true }));
            }
          }, selector);

          await new Promise(resolve => setTimeout(resolve, TIMING.AUTOCOMPLETE_WAIT));

          const fieldValue = await page.evaluate((sel) => {
            const element = document.querySelector(sel) as HTMLInputElement;
            return element ? element.value : null;
          }, selector);

          if (!fieldValue || !fieldValue.includes(text.substring(0, 10))) {
            console.warn(`⚠️  Text might not have been typed correctly. Expected "${text}", field contains "${fieldValue}"`);
          } else {
            console.log(`✓ Verified text was typed: "${fieldValue}"`);
          }

          const dropdownInfo = await page.evaluate((searchText) => {
            const dropdownTexts: string[] = [];

            const dropdownSelectors = [
              '[role="listbox"]', '[role="menu"]',
              '[class*="dropdown"]', '[class*="autocomplete"]',
              '[class*="suggestions"]', 'ul[role="list"]',
              '.pac-container'
            ];

            for (const sel of dropdownSelectors) {
              const dropdown = document.querySelector(sel);
              if (dropdown) {
                const items = dropdown.querySelectorAll('[role="option"], li, a');
                items.forEach(item => {
                  const text = (item.textContent || '').trim();
                  if (text) dropdownTexts.push(text.substring(0, 100));
                });
                if (dropdownTexts.length > 0) break;
              }
            }

            const hasRelevantSuggestion = dropdownTexts.some(t =>
              t.toLowerCase().includes(searchText.toLowerCase())
            );

            return {
              found: dropdownTexts.length > 0,
              suggestions: dropdownTexts.slice(0, 5),
              relevant: hasRelevantSuggestion
            };
          }, text);

          if (dropdownInfo.found && dropdownInfo.relevant) {
            console.log(`✓ Autocomplete dropdown appeared with relevant suggestions:`, dropdownInfo.suggestions);
          } else if (dropdownInfo.found && !dropdownInfo.relevant) {
            console.warn(`⚠️  Autocomplete dropdown appeared but suggestions don't match "${text}":`, dropdownInfo.suggestions);
          } else {
            console.log(`ℹ️  No autocomplete dropdown detected (might be a simple input field)`);
          }

          if (pressEnter || fieldDescription.toLowerCase().includes('search')) {
            console.log(`⏎ Pressing Enter to submit...`);
            const textContentBefore = (await tab.getTabText())?.substring(0, 500) || '';

            await page.keyboard.press('Enter');
            await new Promise(resolve => setTimeout(resolve, TIMING.ENTER_WAIT));

            const urlAfter = tab.url;
            const textContentAfter = (await tab.getTabText())?.substring(0, 500) || '';

            const urlChanged = urlBefore !== urlAfter;
            const contentSignificantlyChanged = textContentBefore !== textContentAfter;

            // Check if URL contains search-related parameters
            const hasSearchParams = urlAfter.includes('search') ||
              urlAfter.includes('results') ||
              urlAfter.includes('query') ||
              urlAfter.includes('q=') ||
              urlAfter.includes('find_desc');

            if (urlChanged || hasSearchParams) {
              cache.invalidateUrl(urlBefore);
              console.log(`✓ Search submitted! Page navigated from ${urlBefore} to ${urlAfter}`);
              return `✅ SEARCH SUCCESSFUL! Typed "${text}" and pressed Enter - now showing search results at ${urlAfter}. Use analyze_website() to see the results.`;
            } else if (contentSignificantlyChanged) {
              cache.invalidateUrl(tab.url);
              console.log(`✓ Search results loaded (SPA - no URL change)`);
              return `✅ SEARCH SUCCESSFUL! Typed "${text}" and pressed Enter - search results appeared (page updated). Use analyze_website() to see the results.`;
            } else {
              // Give it another chance - the page might still be loading
              console.log(`⏳ Waiting longer for search results to load...`);
              await new Promise(resolve => setTimeout(resolve, 2000));

              const urlFinal = tab.url;
              const textContentFinal = (await tab.getTabText())?.substring(0, 500) || '';
              const finalUrlChanged = urlBefore !== urlFinal;
              const finalContentChanged = textContentBefore !== textContentFinal;
              const finalHasSearchParams = urlFinal.includes('search') ||
                urlFinal.includes('results') ||
                urlFinal.includes('query') ||
                urlFinal.includes('q=') ||
                urlFinal.includes('find_desc');

              if (finalUrlChanged || finalHasSearchParams || finalContentChanged) {
                cache.invalidateUrl(urlBefore);
                console.log(`✓ Search submitted after delay! URL: ${urlFinal}`);
                return `✅ SEARCH SUCCESSFUL! Typed "${text}" and pressed Enter - search results loaded. Use analyze_website() to see the results.`;
              } else {
                console.warn(`⚠️  Search might have failed - URL and content didn't change significantly`);
                return `❌ SEARCH FAILED! Pressed Enter but page didn't change. The search box might not be correct or page is blocking automation. Try finding and clicking a search button instead, or use analyze_website() to see if results are already visible.`;
              }
            }
          }

          console.log(`✓ Typed successfully into: "${fieldDescription}"`);

          if (dropdownInfo.found && dropdownInfo.relevant) {
            return `Successfully typed "${text}" into ${fieldDescription}. Autocomplete dropdown appeared with ${dropdownInfo.suggestions.length} suggestions including: ${dropdownInfo.suggestions.join(', ')}. Use click_element to select a suggestion.`;
          } else if (dropdownInfo.found && !dropdownInfo.relevant) {
            return `⚠️ Typed "${text}" into ${fieldDescription}, but autocomplete dropdown shows irrelevant suggestions: ${dropdownInfo.suggestions.join(', ')}. The field might not have updated properly. Try clicking the field first, then typing again, or try a different approach.`;
          } else {
            return `Successfully typed "${text}" into ${fieldDescription}`;
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ Failed to type into "${fieldDescription}": ${errorMsg}`);
          return `ERROR: Could not find or type into "${fieldDescription}". Try describing the element differently. Error: ${errorMsg}`;
        }
      }
    }),

    new DynamicStructuredTool({
      name: 'extract_data',
      description: 'Extract specific information from the current page using vision and text analysis',
      schema: z.object({
        dataToExtract: z.string().describe('What data to extract (e.g., "product price", "article title", "stock price")')
      }),
      func: async ({ dataToExtract }: { dataToExtract: string }) => {
        try {
          const tab = await getActiveTab();
          const text = await tab.getTabText();

          if (!text || text.trim().length === 0) {
            return `ERROR: Could not extract data - page appears to be empty or content is not accessible. The page might still be loading or might require login.`;
          }

          const llm = new ChatOpenAI({
            model: MODELS.FAST,
            temperature: MODELS.TEMPERATURE_FAST
          });

          const result = await llm.invoke([
            { role: 'system', content: 'Extract the requested data from the page text. Return only the extracted data, nothing else.' },
            { role: 'user', content: `Page text:\n${text?.substring(0, CONTENT_LIMITS.EXTRACT_DATA_CHARS)}\n\nExtract: ${dataToExtract}` }
          ]);

          return result.content as string;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ Failed to extract data: ${errorMsg}`);
          return `ERROR: Could not extract "${dataToExtract}" from page. ${errorMsg}`;
        }
      }
    }),

    new DynamicStructuredTool({
      name: 'scroll_page',
      description: 'Scroll the page up or down to see more content',
      schema: z.object({
        direction: z.enum(['up', 'down']).describe('Direction to scroll'),
        amount: z.enum(['small', 'medium', 'large']).optional().default('medium').describe('How much to scroll (default: medium)')
      }),
      func: async ({ direction, amount = 'medium' }: { direction: 'up' | 'down'; amount?: 'small' | 'medium' | 'large' }) => {
        try {
          const tab = await getActiveTab();
          const page = await puppeteer.getPageForTab(tab);

          const scrollAmounts = { small: 300, medium: 600, large: 1200 };
          const pixels = scrollAmounts[amount];
          const scrollValue = direction === 'down' ? pixels : -pixels;

          await page.evaluate((px) => {
            (window as any).scrollBy(0, px);
          }, scrollValue);

          await new Promise(resolve => setTimeout(resolve, TIMING.TAB_SWITCH_DELAY * 2.5));
          return `Scrolled ${direction} by ${amount} amount`;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ Failed to scroll page: ${errorMsg}`);
          return `ERROR: Could not scroll page ${direction}. ${errorMsg}`;
        }
      }
    }),

    new DynamicStructuredTool({
      name: 'wait_for_element',
      description: 'Wait for an element to appear on the page. Useful after navigation or dynamic content loading.',
      schema: z.object({
        description: z.string().describe('Description of element to wait for'),
        timeout: z.number().optional().default(10).describe('Maximum time to wait in seconds (default: 10)')
      }),
      func: async ({ description, timeout = 10 }: { description: string; timeout?: number }) => {
        try {
          const tab = await getActiveTab();
          const selector = await findElementByDescription(tab, description, puppeteer);
          await puppeteer.waitForElement(tab, selector, { timeout: timeout * 1000 });
          return `Element "${description}" appeared on page`;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ Failed to wait for element: ${errorMsg}`);

          if (errorMsg.includes('timeout') || errorMsg.includes('Timeout')) {
            return `❌ TIMEOUT: Element "${description}" did not appear within ${timeout} seconds. The element might not exist, might be hidden, or the page might not have loaded yet. Try:\n- Increasing the timeout\n- Scrolling to make the element visible\n- Checking if you're on the correct page`;
          }

          return `ERROR: Could not find element "${description}". ${errorMsg}`;
        }
      }
    }),

    new DynamicStructuredTool({
      name: 'create_new_tab',
      description: 'Create a new browser tab and optionally navigate to a URL. ONLY use this when you need to work with multiple pages simultaneously (e.g., comparing prices from different sites). For normal navigation, use navigate() instead.',
      schema: z.object({
        url: z.string().optional().describe('URL to open in new tab (optional). If not provided, creates blank tab.')
      }),
      func: async ({ url }: { url?: string }) => {
        try {
          // Check if we already have too many tabs
          const allTabs = window.allTabs;
          if (allTabs.length > 10) {
            console.warn(`⚠️  Already have ${allTabs.length} tabs open. Consider closing some first.`);
            return JSON.stringify({
              success: false,
              warning: `Too many tabs open (${allTabs.length}). Consider using navigate() in current tab instead, or close some tabs first.`,
              currentTabs: allTabs.length
            }, null, 2);
          }

          const newTab = await window.createTab(url || 'about:blank');
          console.log(`✅ Created new tab ${newTab.id}${url ? ` and navigated to ${url}` : ''}`);

          // Notify callback if provided (for tab tracking)
          if (onTabCreated) {
            onTabCreated(newTab);
          }

          return JSON.stringify({
            success: true,
            tabId: newTab.id,
            url: newTab.url,
            message: `Created new tab${url ? ` and navigated to ${url}` : ''}`
          }, null, 2);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ Failed to create new tab: ${errorMsg}`);
          return JSON.stringify({
            success: false,
            error: `Could not create new tab${url ? ` for ${url}` : ''}`,
            details: errorMsg,
            suggestion: 'Try using navigate() in the current tab instead'
          }, null, 2);
        }
      }
    }),

    new DynamicStructuredTool({
      name: 'select_option',
      description: 'Select an option from a dropdown menu (<select> element). Use this for dropdown/select menus.',
      schema: z.object({
        dropdownDescription: z.string().describe('Description of the dropdown (e.g., "country dropdown", "month selector")'),
        optionText: z.string().describe('Text of the option to select (e.g., "United States", "January")')
      }),
      func: async ({ dropdownDescription, optionText }: { dropdownDescription: string; optionText: string }) => {
        try {
          await rateLimiter.throttle();

          console.log(`📋 Selecting "${optionText}" from dropdown: "${dropdownDescription}"`);
          const tab = await getActiveTab();
          const cachedSelector = cache.getElement(dropdownDescription, tab.url);
          let selector: string;

          if (cachedSelector) {
            console.log(`📦 Using cached selector for dropdown: "${dropdownDescription}"`);
            selector = cachedSelector;
          } else {
            selector = await findElementByDescription(tab, dropdownDescription, puppeteer);
            cache.setElement(dropdownDescription, tab.url, selector);
          }

          const page = await puppeteer.getPageForTab(tab);

          try {
            await page.select(selector, optionText);
            console.log(`✓ Selected option "${optionText}" by value`);
            return `Successfully selected "${optionText}" from ${dropdownDescription}`;
          } catch (err) {
            const selected = await page.evaluate((sel, text) => {
              const selectEl = document.querySelector(sel) as HTMLSelectElement;
              if (!selectEl) return false;

              const options = Array.from(selectEl.options);
              const matchingOption = options.find(opt =>
                opt.text.trim().toLowerCase().includes(text.toLowerCase()) ||
                opt.value.trim().toLowerCase().includes(text.toLowerCase())
              );

              if (matchingOption) {
                selectEl.value = matchingOption.value;
                selectEl.dispatchEvent(new Event('change', { bubbles: true }));
                selectEl.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
              }
              return false;
            }, selector, optionText);

            if (selected) {
              console.log(`✓ Selected option "${optionText}" by text matching`);
              return `Successfully selected "${optionText}" from ${dropdownDescription}`;
            } else {
              throw new Error(`Could not find option "${optionText}" in dropdown`);
            }
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`❌ Failed to select option: ${errorMsg}`);
          return `ERROR: Could not select "${optionText}" from "${dropdownDescription}". Error: ${errorMsg}`;
        }
      }
    }),

    new DynamicStructuredTool({
      name: 'press_key',
      description: 'Press a keyboard key or key combination. Examples: "Enter", "Escape", "ArrowDown", "Control+A"',
      schema: z.object({
        key: z.string().describe('Key to press (e.g., "Enter", "Escape", "Tab", "ArrowDown", "Control+C")')
      }),
      func: async ({ key }: { key: string }) => {
        try {
          const tab = await getActiveTab();
          const page = await puppeteer.getPageForTab(tab);

          await page.keyboard.press(key as any);
          return `Pressed keyboard key: ${key}`;
        } catch (error) {
          return `ERROR pressing key: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }),

    new DynamicStructuredTool({
      name: 'upload_file',
      description: 'Upload a file to a file input field. Provide the path to the file on the local system.',
      schema: z.object({
        inputDescription: z.string().describe('Description of the file input field'),
        filePath: z.string().describe('Absolute path to the file to upload')
      }),
      func: async ({ inputDescription, filePath }: { inputDescription: string; filePath: string }) => {
        try {
          await rateLimiter.throttle();

          const tab = await getActiveTab();
          const selector = await findElementByDescription(tab, inputDescription, puppeteer);
          const page = await puppeteer.getPageForTab(tab);

          const inputElement = await page.$(selector) as any;
          if (!inputElement) {
            return `ERROR: File input not found: ${inputDescription}`;
          }

          await inputElement.uploadFile(filePath);
          return `Successfully uploaded file ${filePath} to ${inputDescription}`;
        } catch (error) {
          return `ERROR uploading file: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }),

    new DynamicStructuredTool({
      name: 'right_click',
      description: 'Right-click an element to open context menu',
      schema: z.object({
        description: z.string().describe('Description of element to right-click')
      }),
      func: async ({ description }: { description: string }) => {
        try {
          await rateLimiter.throttle();

          const tab = await getActiveTab();
          const selector = await findElementByDescription(tab, description, puppeteer);
          const page = await puppeteer.getPageForTab(tab);

          await page.click(selector, { button: 'right' });
          return `Right-clicked "${description}"`;
        } catch (error) {
          return `ERROR right-clicking: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }),

    new DynamicStructuredTool({
      name: 'drag_and_drop',
      description: 'Drag an element and drop it onto another element',
      schema: z.object({
        sourceDescription: z.string().describe('Description of element to drag'),
        targetDescription: z.string().describe('Description of element to drop onto')
      }),
      func: async ({ sourceDescription, targetDescription }: { sourceDescription: string; targetDescription: string }) => {
        try {
          await rateLimiter.throttle();

          const tab = await getActiveTab();
          const sourceSelector = await findElementByDescription(tab, sourceDescription, puppeteer);
          const targetSelector = await findElementByDescription(tab, targetDescription, puppeteer);
          const page = await puppeteer.getPageForTab(tab);

          const source = await page.$(sourceSelector);
          const target = await page.$(targetSelector);

          if (!source || !target) {
            return 'ERROR: Could not find source or target element';
          }

          const sourceBox = await source.boundingBox();
          const targetBox = await target.boundingBox();

          if (!sourceBox || !targetBox) {
            return 'ERROR: Could not get bounding boxes';
          }

          await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
          await page.mouse.down();
          await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
          await page.mouse.up();

          return `Dragged "${sourceDescription}" to "${targetDescription}"`;
        } catch (error) {
          return `ERROR dragging element: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }),

    new DynamicStructuredTool({
      name: 'create_scheduled_task',
      description: 'Create a scheduled task that will run automatically at specified times or intervals. ONLY use this when user EXPLICITLY asks to "create task", "create a task to...", "schedule task", "schedule a task to...", "add a scheduled task", etc. Do NOT use for regular commands like "check my email" - only when they specifically want to CREATE or SCHEDULE a task for future automatic execution. The task will run in headless mode (no visible browser) and show notifications when complete.',
      schema: z.object({
        name: z.string().describe('Short descriptive name for the task (e.g., "Check Email", "Tesla Stock Analysis")'),
        prompt: z.string().describe('The automation task to perform - what the agent should do when the task runs'),
        scheduleType: z.enum(['delay', 'recurring', 'cron']).describe('Type of schedule: "delay" for one-time after X minutes, "recurring" for regular intervals (every X minutes), "cron" for specific times'),
        intervalMinutes: z.number().optional().describe('For recurring tasks: interval in minutes (e.g., 1 for every minute, 60 for hourly)'),
        cronExpression: z.string().optional().describe('For cron tasks: cron expression (e.g., "0 8 * * *" for 8 AM daily)'),
        delayMinutes: z.number().optional().describe('For delay tasks: number of minutes to wait before first execution')
      }),
      func: async ({ name, prompt, scheduleType, intervalMinutes, cronExpression, delayMinutes }) => {
        const scheduler = window.taskScheduler;
        if (!scheduler) {
          return 'ERROR: Task scheduler is not available. The scheduler may not have initialized properly.';
        }

        let schedule: any;

        if (scheduleType === 'delay') {
          schedule = {
            type: 'delay',
            delayMinutes: delayMinutes || 60
          };
        } else if (scheduleType === 'recurring') {
          if (!intervalMinutes) {
            return 'ERROR: intervalMinutes is required for recurring tasks';
          }
          schedule = {
            type: 'recurring',
            intervalMinutes: intervalMinutes
          };
        } else if (scheduleType === 'cron') {
          if (!cronExpression) {
            return 'ERROR: cronExpression is required for cron tasks';
          }
          schedule = {
            type: 'cron',
            expression: cronExpression
          };
        }

        try {
          const task = await scheduler.createTask({
            name,
            prompt,
            schedule
          });

          let scheduleDescription = '';
          if (scheduleType === 'delay') {
            scheduleDescription = `in ${delayMinutes} minutes`;
          } else if (scheduleType === 'recurring') {
            scheduleDescription = `every ${intervalMinutes} minute${intervalMinutes !== 1 ? 's' : ''}`;
          } else if (scheduleType === 'cron') {
            scheduleDescription = `at ${cronExpression}`;
          }

          return `✅ Successfully created scheduled task "${name}" (ID: ${task.id})
Schedule: ${scheduleDescription}
Status: ${task.enabled ? 'Enabled' : 'Disabled'}
Next run: ${task.nextRun ? new Date(task.nextRun).toLocaleString() : 'Not scheduled'}

The task will run in headless mode (invisible browser) and you'll receive a desktop notification when it completes. You can view and manage this task in the Tasks tab of the sidebar.`;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          return `❌ Failed to create scheduled task: ${errorMsg}`;
        }
      }
    }),

    ...createDocumentTools()
  ];
}

/**
 * Find element using vision-based description
 * Uses LLM to match description to actual page elements
 */
async function findElementByDescription(
  tab: any,
  description: string,
  puppeteerManager: any,
  options?: { maxRetries?: number; scrollIfNotFound?: boolean }
): Promise<string> {
  const maxRetries = options?.maxRetries || 3;
  const scrollIfNotFound = options?.scrollIfNotFound ?? true;

  console.log(`🔍 Finding element: "${description}"`);

  const page: Page = await puppeteerManager.getPageForTab(tab);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`🔍 Attempt ${attempt}/${maxRetries} to find: "${description}"`);

    const elements = await page.evaluate(() => {
      const interactiveSelectors = 'button, a, input, textarea, select, [role="button"], [role="tab"], [role="link"], div[onclick], span[onclick], div[class*="button"], div[class*="tab"], span[class*="button"]';

      function getAllElementsIncludingShadow(root: Document | ShadowRoot): Element[] {
        const elements: Element[] = [];
        elements.push(...Array.from(root.querySelectorAll(interactiveSelectors)));
        root.querySelectorAll('*').forEach(el => {
          if (el.shadowRoot) {
            elements.push(...getAllElementsIncludingShadow(el.shadowRoot));
          }
        });
        return elements;
      }

      const allElements = getAllElementsIncludingShadow(document);

      function generateUniqueSelector(el: Element): string {
        function escapeAttributeValue(value: string): string {
          return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        }

        function isSafeSelectorValue(value: string): boolean {
          return !/["'\\[\]()]/g.test(value);
        }

        if (el.id && isSafeSelectorValue(el.id)) {
          return `#${CSS.escape(el.id)}`;
        }

        const safeDataAttrs = Array.from(el.attributes)
          .filter(attr => attr.name.startsWith('data-') && isSafeSelectorValue(attr.value))
          .map(attr => `[${attr.name}="${escapeAttributeValue(attr.value)}"]`)
          .join('');

        if (safeDataAttrs) {
          try {
            const testSelector = `${el.tagName.toLowerCase()}${safeDataAttrs}`;
            const matchingElements = document.querySelectorAll(testSelector);
            if (matchingElements.length === 1) {
              return testSelector;
            }
          } catch (e) {
          }
        }

        if (el.className && typeof el.className === 'string') {
          const classes = el.className.split(' ')
            .filter(c => c && isSafeSelectorValue(c))
            .map(c => `.${CSS.escape(c)}`)
            .join('');

          if (classes) {
            try {
              const testSelector = `${el.tagName.toLowerCase()}${classes}`;
              const matchingElements = document.querySelectorAll(testSelector);
              if (matchingElements.length === 1) {
                return testSelector;
              }
            } catch (e) {
            }
          }
        }

        let nth = 1;
        let sibling = el.previousElementSibling;
        while (sibling) {
          if (sibling.tagName === el.tagName) nth++;
          sibling = sibling.previousElementSibling;
        }

        const parent = el.parentElement;
        if (parent) {
          if (parent.id && isSafeSelectorValue(parent.id)) {
            return `#${CSS.escape(parent.id)} > ${el.tagName.toLowerCase()}:nth-child(${nth})`;
          }
          return `${parent.tagName.toLowerCase()} > ${el.tagName.toLowerCase()}:nth-child(${nth})`;
        }

        return `${el.tagName.toLowerCase()}:nth-of-type(${nth})`;
      }

      return allElements.map((el, index) => {
        const rect = el.getBoundingClientRect();

        return {
          index,
          tag: el.tagName.toLowerCase(),
          text: (el as HTMLElement).innerText?.trim().substring(0, 100) || '',
          placeholder: (el as HTMLInputElement).placeholder || '',
          type: (el as HTMLInputElement).type || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          role: el.getAttribute('role') || '',
          id: el.id || '',
          className: el.className || '',
          visible: rect.width > 0 && rect.height > 0,
          position: `x:${Math.round(rect.left)},y:${Math.round(rect.top)}`,
          selector: generateUniqueSelector(el)
        };
      }).filter(el => el.visible);
    });

    console.log(`📊 Found ${elements.length} interactive elements on page`);

    if (elements.length === 0) {
      if (attempt < maxRetries && scrollIfNotFound) {
        console.log(`⏬ No elements found, scrolling page to load more...`);
        await page.evaluate(() => window.scrollBy(0, 500));
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      throw new Error(`No interactive elements found on page for: ${description}`);
    }

    console.log(`📋 Sample elements:`, elements.slice(0, 5).map(e => ({
      index: e.index,
      tag: e.tag,
      text: e.text?.substring(0, 30),
      role: e.role,
      ariaLabel: e.ariaLabel?.substring(0, 30)
    })));

    // Use LLM with structured output to find best matching element
    const llm = new ChatOpenAI({
      model: 'gpt-4o-mini',
      temperature: 0
    }).withStructuredOutput(
      z.object({
        elementIndex: z.number().min(0).describe('The index of the best matching element'),
        confidence: z.number().min(0).max(1).describe('Confidence score (0-1) in the match'),
        reasoning: z.string().nullable().optional().describe('Brief explanation of why this element matches')
      })
    );

    const filteredElements = intelligentElementFilter(elements, description, 20);

    const elementsForLLM = filteredElements.map((el, idx) => ({
      match_index: idx,
      tag: el.tag,
      text: el.text,
      placeholder: el.placeholder,
      ariaLabel: el.ariaLabel,
      role: el.role,
      id: el.id
    }));

    console.log(`🎯 Smart filtered ${elements.length} elements down to ${elementsForLLM.length} candidates`);

    const prompt = `Find the HTML element that best matches the description.

Available elements (${elementsForLLM.length} total):
${JSON.stringify(elementsForLLM, null, 2)}

User wants to interact with: "${description}"

Look for:
- Exact text match in "text" field
- Similar content in "ariaLabel" field
- Matching "role" (e.g., role:"tab", role:"button")
- Related "placeholder" text
- Relevant "id" field

Return the match_index of the best matching element with your confidence level.`;

    console.log(`🤖 Asking LLM to find: "${description}" among ${elementsForLLM.length} elements`);

    const result = await llm.invoke(prompt);
    const index = result.elementIndex;

    console.log(`🤖 LLM selected index ${index} with ${(result.confidence * 100).toFixed(0)}% confidence${result.reasoning ? `: ${result.reasoning}` : ''}`);

    if (index === undefined || isNaN(index) || index < 0 || index >= filteredElements.length) {
      console.error(`❌ Invalid index from LLM: ${index}`);
      console.error(`   Expected: 0-${filteredElements.length - 1}`);
      console.error(`   LLM Response:`, result);
      console.error(`   Available elements:`, filteredElements.slice(0, 5).map(e => ({
        text: e.text?.substring(0, 30),
        ariaLabel: e.ariaLabel?.substring(0, 30),
        role: e.role
      })));

      if (attempt < maxRetries && scrollIfNotFound) {
        console.log(`⏬ Scrolling page to load more elements...`);
        await page.evaluate(() => window.scrollBy(0, 500));
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }

      // Provide helpful error with available elements
      const availableElements = filteredElements.slice(0, 10).map(e => ({
        text: e.text?.substring(0, 50),
        ariaLabel: e.ariaLabel?.substring(0, 50),
        role: e.role
      }));

      throw new Error(`Could not find element matching "${description}". Available elements: ${JSON.stringify(availableElements, null, 2)}`);
    }

    const selectedElement = filteredElements[index];

    console.log(`✅ Found element at index ${index}: ${selectedElement.tag} "${selectedElement.text?.substring(0, 30)}"`);

    const selector = selectedElement.selector;

    console.log(`🎯 Using selector: ${selector}`);
    return selector;
  }

  throw new Error(`Could not find element "${description}" after ${maxRetries} attempts`);
}
