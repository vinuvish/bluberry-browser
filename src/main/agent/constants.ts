/**
 * Agent System Constants
 * Centralized configuration values to avoid magic numbers
 */

/**
 * Timing constants (milliseconds)
 */
export const TIMING = {
  TAB_SWITCH_DELAY: 200,
  ACTION_DELAY: 500, // Reduced from 1000ms for faster execution
  PAGE_LOAD_TIMEOUT: 30000,
  SELECTOR_TIMEOUT: 5000,
  POPUP_DISMISS_DELAY: 400,
  CLICK_WAIT: 500, // Reduced from 1000ms
  TYPE_CHAR_DELAY: 30, // Reduced from 50ms
  AUTOCOMPLETE_WAIT: 500, // Reduced from 800ms
  ENTER_WAIT: 1500, // Reduced from 2000ms
  STALE_CONNECTION_RETRY_DELAY: 500,
} as const;

/**
 * Retry limits
 */
export const RETRY_LIMITS = {
  MAX_ELEMENT_FIND_ATTEMPTS: 3,
  STALE_CONNECTION_RETRIES: 2,
  NETWORK_ERROR_RETRIES: 2,
  MAX_AGENT_ITERATIONS: 60, // Increased for complex multi-step tasks like Excel creation
} as const;

/**
 * Loop detection configuration
 */
export const LOOP_DETECTION = {
  DEFAULT_THRESHOLD: 6,
  PARALLEL_TOOL_THRESHOLD: 15, // Allow more repetitions for parallel tools (e.g. opening multiple tabs)
  PARALLEL_TOOLS: ['create_new_tab', 'extract_smart_content', 'navigate'],
  PATTERN_CHECK_LENGTH: 8,
} as const;

/**
 * Content limits
 */
export const CONTENT_LIMITS = {
  OBSERVE_PAGE_CHARS: 1500,
  EXTRACT_DATA_CHARS: 1000,
  ELEMENT_TEXT_CHARS: 100,
  SUGGESTION_TEXT_CHARS: 100,
  TEXT_SNAPSHOT_CHARS: 500,
  MAX_SUGGESTIONS: 5,
  MAX_ELEMENTS_TO_LLM: 20,
} as const;

/**
 * Cookie dialog patterns
 */
export const COOKIE_PATTERNS = {
  PRIORITY_TEXTS: ['accept all', 'allow all', 'accept all cookies'],
  ACCEPT_TEXTS: ['accept', 'agree', 'consent', 'got it', 'ok'],
  SKIP_TEXTS: ['shop', 'buy', 'sign', 'cart', 'learn more', 'settings', 'manage'],
  MAX_BUTTON_TEXT_LENGTH: 30,
  MAX_BUTTON_WIDTH: 400,
} as const;

/**
 * Overlay/Modal detection patterns
 */
export const OVERLAY_PATTERNS = {
  SELECTORS: [
    '[class*="overlay"]',
    '[class*="modal"]',
    '[class*="popup"]',
    '[class*="backdrop"]',
    '[id*="overlay"]',
    '[id*="modal"]',
  ],
  MIN_Z_INDEX: 999,
  MIN_COVERAGE_RATIO: 0.5,
} as const;

/**
 * Element selector patterns for finding interactive elements
 */
export const ELEMENT_SELECTORS = {
  INTERACTIVE: 'button, a, input, textarea, select, [role="button"], [role="tab"], [role="link"], div[onclick], span[onclick], div[class*="button"], div[class*="tab"], span[class*="button"]',
  DROPDOWN: [
    '[role="listbox"]',
    '[role="menu"]',
    '[class*="dropdown"]',
    '[class*="autocomplete"]',
    '[class*="suggestions"]',
    'ul[role="list"]',
    '.pac-container',
  ],
} as const;

/**
 * Request interception patterns (for performance)
 */
export const BLOCK_PATTERNS = {
  RESOURCE_TYPES: ['image', 'font', 'media', 'stylesheet'] as const,
  ANALYTICS: [
    'google-analytics',
    'googletagmanager',
    'doubleclick',
    'facebook.com/tr',
    'hotjar',
    'mixpanel',
    'segment.com',
    'amplitude',
  ],
} as const;

/**
 * Model configurations
 */
export const MODELS = {
  MAIN: 'gpt-4o-mini',
  FAST: 'gpt-4o-mini',
  TEMPERATURE_MAIN: 0.1,
  TEMPERATURE_FAST: 0,
} as const;

/**
 * Error message patterns for detection
 */
export const ERROR_PATTERNS = {
  STALE_CONNECTION: [
    'Execution context was destroyed',
    'Target closed',
    'Session closed',
    'Protocol error',
    'Unable to find puppeteer Page',
  ],
  NETWORK: [
    'net::ERR_',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
  ],
} as const;

/**
 * Planning constants for DeepAgents-style orchestration
 */
export const PLANNING = {
  MAX_PLAN_STEPS: 20,
  PLAN_LLM_MODEL: 'gpt-4o-mini',
  PLAN_TEMPERATURE: 0,
  MIN_STEPS_FOR_PLANNING: 3, // Only create plans for tasks with 3+ steps
} as const;

/**
 * Context management constants
 */
export const CONTEXT = {
  STORAGE_DIR: 'agent-context',
  MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB
  CLEANUP_AFTER_DAYS: 30,
} as const;

/**
 * Memory/checkpointing constants
 */
export const MEMORY = {
  STORAGE_DIR: 'agent-memory',
  CHECKPOINT_RETENTION_DAYS: 90,
  AUTO_CLEANUP_ENABLED: true,
} as const;
