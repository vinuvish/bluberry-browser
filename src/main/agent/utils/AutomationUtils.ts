/**
 * Automation Utilities
 * Shared helpers for browser automation with retry logic, rate limiting, etc.
 */

import type { Page, Frame } from 'puppeteer-core';

/**
 * Retry operation with exponential backoff
 * LangChain doesn't have a built-in retry utility, so we implement this
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
    retryOn?: (error: Error) => boolean;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelay = 500,
    maxDelay = 5000,
    retryOn = () => true
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry this error
      if (!retryOn(lastError)) {
        throw lastError;
      }

      if (attempt === maxRetries) {
        throw lastError;
      }

      const delay = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay);
      console.warn(`⚠️  Attempt ${attempt}/${maxRetries} failed: ${lastError.message}`);
      console.warn(`⏱️  Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Retry failed');
}

/**
 * Check if error is a network error that should be retried
 */
export function isNetworkError(error: Error): boolean {
  const networkErrorPatterns = [
    'net::ERR',
    'Navigation timeout',
    'TimeoutError',
    'ECONNREFUSED',
    'ENOTFOUND',
    'ETIMEDOUT',
    'socket hang up',
    'Protocol error'
  ];

  return networkErrorPatterns.some(pattern =>
    error.message.includes(pattern)
  );
}

/**
 * Detect CAPTCHA on page
 */
export async function detectCaptcha(page: Page): Promise<{
  hasCaptcha: boolean;
  type?: 'recaptcha' | 'hcaptcha' | 'cloudflare' | 'custom';
  message?: string;
}> {
  const captchaInfo = await page.evaluate(() => {
    // Check for common CAPTCHA indicators
    const checks = [
      {
        selector: 'iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"], .g-recaptcha',
        type: 'recaptcha' as const,
        message: 'Google reCAPTCHA detected'
      },
      {
        selector: 'iframe[src*="hcaptcha"], .h-captcha',
        type: 'hcaptcha' as const,
        message: 'hCaptcha detected'
      },
      {
        selector: '#challenge-form, .cf-challenge-running, .cf-browser-verification',
        type: 'cloudflare' as const,
        message: 'Cloudflare challenge detected'
      },
      {
        selector: '[class*="captcha"], [id*="captcha"], [class*="challenge"]',
        type: 'custom' as const,
        message: 'CAPTCHA or challenge detected'
      }
    ];

    for (const check of checks) {
      if (document.querySelector(check.selector)) {
        return {
          hasCaptcha: true,
          type: check.type,
          message: check.message
        };
      }
    }

    return { hasCaptcha: false };
  });

  return captchaInfo;
}

/**
 * Rate limiter to prevent rapid-fire requests
 */
export class RateLimiter {
  private lastRequestTime: number = 0;
  private minDelay: number;

  constructor(minDelayMs: number = 1000) {
    this.minDelay = minDelayMs;
  }

  async throttle(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.minDelay) {
      const delay = this.minDelay - timeSinceLastRequest;
      console.log(`⏱️  Rate limiting: waiting ${delay}ms before next action...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    this.lastRequestTime = Date.now();
  }

  setMinDelay(delayMs: number): void {
    this.minDelay = delayMs;
  }
}

/**
 * Find elements in all frames (including iframes)
 */
export async function findElementsInAllFrames(
  page: Page,
  evaluateFunc: (frame: Frame) => Promise<any[]>
): Promise<{ elements: any[]; frame: Frame }[]> {
  const results: { elements: any[]; frame: Frame }[] = [];

  // Get all frames
  const frames = page.frames();

  for (const frame of frames) {
    try {
      const elements = await evaluateFunc(frame);
      if (elements && elements.length > 0) {
        results.push({ elements, frame });
      }
    } catch (error) {
      // Skip frames we can't access (cross-origin)
      const errorMsg = (error as Error).message;
      if (!errorMsg?.includes('cross-origin')) {
        console.warn(`⚠️  Could not search frame: ${frame.url()}`, errorMsg);
      }
    }
  }

  return results;
}

/**
 * Extract all elements including Shadow DOM
 */
export async function getAllElementsIncludingShadow(page: Page, selectors: string): Promise<any[]> {
  return await page.evaluate((selectorString) => {
    // Recursive function to find all elements including shadow DOM
    function getAllElements(root: Document | ShadowRoot): Element[] {
      const elements: Element[] = [];

      // Get elements from current root
      elements.push(...Array.from(root.querySelectorAll(selectorString)));

      // Recursively search shadow DOMs
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) {
          elements.push(...getAllElements(el.shadowRoot));
        }
      });

      return elements;
    }

    return getAllElements(document);
  }, selectors);
}

/**
 * Wait for one of multiple conditions
 * @param _page - Page instance (reserved for future use)
 * @param conditions - Array of async functions to race
 * @param timeout - Timeout in milliseconds
 */
export async function waitForAny(
  _page: Page,
  conditions: Array<() => Promise<any>>,
  timeout: number = 3000
): Promise<{ index: number; result: any } | null> {
  const promises = conditions.map((condition, index) =>
    condition()
      .then(result => ({ index, result }))
      .catch(() => null)
  );

  // Add timeout
  const timeoutPromise = new Promise<null>(resolve =>
    setTimeout(() => resolve(null), timeout)
  );

  const result = await Promise.race([...promises, timeoutPromise]);
  return result;
}

/**
 * Smart element filtering using heuristics with enhanced scoring
 */
export function intelligentElementFilter(
  elements: any[],
  description: string,
  maxElements: number = 20
): any[] {
  const descLower = description.toLowerCase();
  const keywords = descLower.split(/\s+/).filter(k => k.length > 2);

  // Score each element with enhanced heuristics
  const scored = elements.map(el => {
    let score = 0;

    // Exact text match = highest score
    if (el.text?.toLowerCase().includes(descLower)) {
      score += 100;
    }

    // Partial text match
    if (el.text?.toLowerCase().includes(descLower.substring(0, Math.min(descLower.length, 10)))) {
      score += 50;
    }

    // Keyword matches with position weighting
    keywords.forEach((keyword, index) => {
      const weight = keywords.length - index; // First keywords are more important
      if (el.text?.toLowerCase().includes(keyword)) score += 10 * weight;
      if (el.ariaLabel?.toLowerCase().includes(keyword)) score += 10 * weight;
      if (el.placeholder?.toLowerCase().includes(keyword)) score += 8 * weight;
      if (el.role?.toLowerCase().includes(keyword)) score += 5 * weight;
      if (el.id?.toLowerCase().includes(keyword)) score += 5 * weight;
      if (el.className?.toLowerCase().includes(keyword)) score += 3 * weight;
    });

    // Bonus for visible and properly sized elements
    if (el.visible) score += 5;
    if (el.width > 50 && el.height > 20) score += 5;
    if (el.width > 100 && el.height > 30) score += 5; // Larger elements are more likely to be interactive

    // Penalize hidden/tiny elements
    if (el.width < 20 || el.height < 20) score -= 50;
    if (el.opacity < 0.1) score -= 50;
    if (el.computedDisplay === 'none') score -= 100;

    // Bonus for interactive elements
    if (el.tag === 'button' || el.tag === 'a' || el.tag === 'input') score += 3;
    if (el.role === 'button' || el.role === 'link') score += 3;
    if (el.type === 'submit' || el.type === 'button') score += 5;

    // Bonus for elements in viewport center
    if (el.position) {
      const match = el.position.match(/x:(\d+),y:(\d+)/);
      if (match) {
        const x = parseInt(match[1]);
        const y = parseInt(match[2]);
        // Elements near center are more likely to be important
        if (x > 100 && x < 800 && y > 100 && y < 600) {
          score += 3;
        }
      }
    }

    return { ...el, _score: score };
  });

  // Return top N elements
  return scored
    .filter(el => el._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, maxElements);
}

/**
 * Enhanced error recovery with multiple strategies
 */
export async function retryWithStrategies<T>(
  operation: () => Promise<T>,
  strategies: Array<(attempt: number) => Promise<void>>,
  options: {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelay = 500,
    maxDelay = 5000,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === maxRetries) {
        throw lastError;
      }

      const strategy = strategies[attempt - 1];
      if (strategy) {
        try {
          await strategy(attempt);
        } catch (strategyError) {
          console.warn(`Strategy ${attempt} failed:`, strategyError);
        }
      }

      const delay = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay);
      console.warn(`⚠️  Attempt ${attempt}/${maxRetries} failed: ${lastError.message}`);
      console.warn(`⏱️  Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Retry failed');
}
