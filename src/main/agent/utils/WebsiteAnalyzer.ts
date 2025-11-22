/**
 * Intelligent Website Analyzer
 * Uses GPT-4 Vision + DOM analysis to understand website structure and content
 */

import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import type { Page } from 'puppeteer-core';
import type { Tab } from '../../Tab';
import { MODELS } from '../constants';

/**
 * Page type classification
 */
export type PageType =
  | 'homepage'
  | 'product'
  | 'article'
  | 'search_results'
  | 'login'
  | 'form'
  | 'dashboard'
  | 'profile'
  | 'checkout'
  | 'email'
  | 'social_media'
  | 'documentation'
  | 'unknown';

/**
 * Semantic page analysis result
 */
export interface PageAnalysis {
  // Page classification
  pageType: PageType;
  confidence: number;

  // Main content
  mainContent: {
    title?: string;
    description?: string;
    keyPoints: string[];
    data: Record<string, any>;
  };

  // Actionable elements
  actions: {
    buttons: Array<{ text: string; purpose: string; selector?: string }>;
    forms: Array<{ purpose: string; fields: string[] }>;
    links: Array<{ text: string; purpose: string; url?: string }>;
  };

  // Navigation suggestions
  suggestions: {
    nextSteps: string[];
    relevantAreas: string[];
  };

  // Structured data (if available)
  structuredData?: {
    schema?: any;
    openGraph?: Record<string, string>;
    jsonLd?: any[];
  };
}

/**
 * Extract structured data from page (Schema.org, Open Graph, JSON-LD)
 */
async function extractStructuredData(page: Page): Promise<PageAnalysis['structuredData']> {
  return await page.evaluate(() => {
    const data: any = {};

    // Extract Open Graph metadata
    const ogTags = Array.from(document.querySelectorAll('meta[property^="og:"]'));
    if (ogTags.length > 0) {
      data.openGraph = {};
      ogTags.forEach((tag) => {
        const property = tag.getAttribute('property')?.replace('og:', '');
        const content = tag.getAttribute('content');
        if (property && content) {
          data.openGraph[property] = content;
        }
      });
    }

    // Extract JSON-LD structured data
    const jsonLdScripts = Array.from(
      document.querySelectorAll('script[type="application/ld+json"]')
    );
    if (jsonLdScripts.length > 0) {
      data.jsonLd = [];
      jsonLdScripts.forEach((script) => {
        try {
          const json = JSON.parse(script.textContent || '');
          data.jsonLd.push(json);
        } catch (e) {
          // Invalid JSON, skip
        }
      });
    }

    // Extract Schema.org microdata
    const schemaElements = Array.from(document.querySelectorAll('[itemtype]'));
    if (schemaElements.length > 0) {
      data.schema = schemaElements.map((el) => ({
        type: el.getAttribute('itemtype'),
        properties: Array.from(el.querySelectorAll('[itemprop]')).map((prop) => ({
          name: prop.getAttribute('itemprop'),
          content:
            (prop as HTMLElement).textContent?.trim() ||
            prop.getAttribute('content') ||
            prop.getAttribute('href'),
        })),
      }));
    }

    return Object.keys(data).length > 0 ? data : undefined;
  });
}

/**
 * Extract semantic page information using DOM analysis
 */
async function extractSemanticInfo(page: Page): Promise<{
  title?: string;
  description?: string;
  headings: string[];
  paragraphs: string[];
  lists: string[];
  tables: Array<Record<string, string>>;
  forms: Array<{ action?: string; fields: string[] }>;
  links: Array<{ text: string; url: string }>;
}> {
  return await page.evaluate(() => {
    // Title and description
    const title =
      document.querySelector('h1')?.textContent?.trim() ||
      document.querySelector('title')?.textContent?.trim();

    const description =
      document.querySelector('meta[name="description"]')?.getAttribute('content') ||
      document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
      undefined;

    // Headings (hierarchy)
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
      .map((h) => h.textContent?.trim())
      .filter((t) => t && t.length > 0) as string[];

    // Main paragraphs (content)
    const paragraphs = Array.from(
      document.querySelectorAll('p, article p, main p, [role="main"] p')
    )
      .map((p) => p.textContent?.trim())
      .filter((t) => t && t.length > 20 && t.length < 500)
      .slice(0, 10) as string[];

    // Lists (structured content)
    const lists = Array.from(document.querySelectorAll('ul, ol'))
      .map((list) => {
        const items = Array.from(list.querySelectorAll('li'))
          .map((li) => li.textContent?.trim())
          .filter((t) => t && t.length > 0);
        return items.join(' • ');
      })
      .filter((l) => l.length > 0)
      .slice(0, 5);

    // Tables (structured data)
    const tables = Array.from(document.querySelectorAll('table'))
      .map((table) => {
        const headers = Array.from(table.querySelectorAll('th')).map(
          (th) => th.textContent?.trim() || ''
        );
        const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) => {
          const cells = Array.from(tr.querySelectorAll('td')).map(
            (td) => td.textContent?.trim() || ''
          );
          const row: Record<string, string> = {};
          headers.forEach((header, i) => {
            row[header] = cells[i] || '';
          });
          return row;
        });
        return rows;
      })
      .flat()
      .slice(0, 20);

    // Forms (interactive elements)
    const forms = Array.from(document.querySelectorAll('form')).map((form) => ({
      action: form.getAttribute('action') || undefined,
      fields: Array.from(form.querySelectorAll('input, textarea, select'))
        .map(
          (field) =>
            (field as HTMLInputElement).name ||
            (field as HTMLInputElement).id ||
            field.getAttribute('placeholder') ||
            ''
        )
        .filter((f) => f.length > 0),
    }));

    // Important links
    const links = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => ({
        text: a.textContent?.trim() || '',
        url: a.getAttribute('href') || '',
      }))
      .filter((l) => l.text.length > 0 && l.text.length < 100)
      .slice(0, 50);

    return {
      title,
      description,
      headings,
      paragraphs,
      lists,
      tables,
      forms,
      links,
    };
  });
}

/**
 * Analyze page using GPT-4 Vision (screenshot + DOM analysis)
 */
export class WebsiteAnalyzer {
  private visionLLM: ChatOpenAI;
  private fastLLM: ChatOpenAI;

  constructor() {
    // GPT-4 Vision for screenshot analysis
    this.visionLLM = new ChatOpenAI({
      modelName: MODELS.MAIN,
      temperature: 0,
      maxTokens: 2000,
    });

    // Fast model for text analysis
    this.fastLLM = new ChatOpenAI({
      modelName: MODELS.FAST,
      temperature: MODELS.TEMPERATURE_FAST,
      maxTokens: 2000,
    });
  }

  /**
   * Analyze a website comprehensively
   */
  async analyze(_tab: Tab, page: Page, userIntent?: string): Promise<PageAnalysis> {
    try {
      console.log('🔍 Analyzing website with intelligent understanding...');

      // 1. Extract structured data (with error handling)
      let structuredData;
      try {
        structuredData = await extractStructuredData(page);
      } catch (error) {
        console.warn('⚠️  Failed to extract structured data:', error);
        structuredData = null;
      }

      // 2. Extract semantic information (with error handling)
      let semantic;
      try {
        semantic = await extractSemanticInfo(page);
      } catch (error) {
        console.warn('⚠️  Failed to extract semantic info:', error);
        // Provide fallback semantic data
        semantic = {
          title: 'Unknown',
          description: '',
          headings: [],
          paragraphs: [],
          links: [],
          forms: [],
          tables: [],
          lists: [],
        };
      }

      // 3. Take screenshot for visual analysis (with error handling)
      let screenshot: string;
      try {
        screenshot = (await page.screenshot({ encoding: 'base64', fullPage: false })) as string;
      } catch (error) {
        console.warn('⚠️  Failed to take screenshot:', error);
        // Use empty screenshot - visual analysis will still work with DOM data
        screenshot = '';
      }

      // 4. Analyze with GPT-4 Vision (with error handling)
      let visualAnalysis;
      try {
        visualAnalysis = await this.analyzeVisually(screenshot, semantic, userIntent);
      } catch (error) {
        console.warn('⚠️  Visual analysis failed, using fallback:', error);
        // Provide fallback analysis
        visualAnalysis = {
          pageType: 'unknown' as PageType,
          confidence: 0.5,
          mainContent: {
            title: semantic.title || 'Unknown',
            description: semantic.description || 'Unable to analyze page',
            keyPoints: ['Page analysis encountered issues'],
            data: {},
          },
          actions: {
            buttons: [],
            forms: semantic.forms || [],
            links: semantic.links.slice(0, 5) || [],
          },
          suggestions: {
            nextSteps: ['Try navigating to the page again'],
            relevantAreas: [],
          },
        };
      }

      // 5. Combine all analyses
      const analysis: PageAnalysis = {
        ...visualAnalysis,
        structuredData,
      };

      console.log(`✅ Page analyzed as: ${analysis.pageType} (${Math.round(analysis.confidence * 100)}% confidence)`);

      return analysis;
    } catch (error) {
      console.error('❌ Complete analysis failure:', error);
      // Return a minimal valid analysis to prevent tool failure
      return {
        pageType: 'unknown' as PageType,
        confidence: 0.3,
        mainContent: {
          title: 'Unknown',
          description: 'Page analysis failed',
          keyPoints: ['Unable to analyze page'],
          data: {},
        },
        actions: {
          buttons: [],
          forms: [],
          links: [],
        },
        suggestions: {
          nextSteps: ['Try navigating to the page again'],
          relevantAreas: [],
        },
        structuredData: undefined,
      };
    }
  }

  /**
   * Analyze page visually using GPT-4 Vision
   */
  private async analyzeVisually(
    screenshot: string,
    semantic: Awaited<ReturnType<typeof extractSemanticInfo>>,
    userIntent?: string
  ): Promise<Omit<PageAnalysis, 'structuredData'>> {
    const prompt = `You are analyzing a website screenshot and DOM structure. ${userIntent ? `User wants to: "${userIntent}"` : ''
      }

**Page Information:**
- Title: ${semantic.title || 'Unknown'}
- Description: ${semantic.description || 'None'}
- Headings: ${semantic.headings.slice(0, 5).join(', ')}
- Has Forms: ${semantic.forms.length > 0 ? 'Yes' : 'No'}
- Main Links: ${semantic.links.slice(0, 10).map((l) => l.text).join(', ')}

**Analyze this page and provide:**

1. **Page Type** (homepage, product, article, search_results, login, form, dashboard, profile, checkout, email, social_media, documentation, or unknown)

2. **Confidence** (0-1) in your classification

3. **Main Content** - Extract the key information:
   - What is this page about?
   - What are the 3-5 most important points?
   - Any specific data (prices, dates, names, etc.)?

4. **Actionable Elements** - What can the user do?
   - Important buttons and their purposes
   - Forms and what they're for
   - Key links and where they lead

5. **Next Steps** - What would a user typically do here?
   - Natural next actions
   - Relevant areas to explore

Respond in valid JSON format:
{
  "pageType": "...",
  "confidence": 0.95,
  "mainContent": {
    "title": "...",
    "description": "...",
    "keyPoints": ["...", "...", "..."],
    "data": {"key": "value"}
  },
  "actions": {
    "buttons": [{"text": "...", "purpose": "..."}],
    "forms": [{"purpose": "...", "fields": ["...", "..."]}],
    "links": [{"text": "...", "purpose": "..."}]
  },
  "suggestions": {
    "nextSteps": ["...", "...", "..."],
    "relevantAreas": ["...", "...", "..."]
  }
}`;

    const response = await this.visionLLM.invoke([
      new HumanMessage({
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${screenshot}`,
              detail: 'high',
            },
          },
        ],
      }),
    ]);

    // Parse JSON response
    try {
      const content = response.content as string;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }
      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.error('Failed to parse visual analysis:', error);
      // Fallback to basic analysis
      return this.createFallbackAnalysis(semantic);
    }
  }

  /**
   * Create fallback analysis if vision fails
   */
  private createFallbackAnalysis(
    semantic: Awaited<ReturnType<typeof extractSemanticInfo>>
  ): Omit<PageAnalysis, 'structuredData'> {
    // Simple heuristic-based classification
    let pageType: PageType = 'unknown';
    if (semantic.forms.some((f) => f.fields.includes('email') || f.fields.includes('password'))) {
      pageType = 'login';
    } else if (semantic.forms.length > 0) {
      pageType = 'form';
    } else if (semantic.headings[0]?.toLowerCase().includes('search')) {
      pageType = 'search_results';
    } else if (semantic.paragraphs.length > 5) {
      pageType = 'article';
    } else if (semantic.title?.toLowerCase().includes('home')) {
      pageType = 'homepage';
    }

    return {
      pageType,
      confidence: 0.5,
      mainContent: {
        title: semantic.title,
        description: semantic.description,
        keyPoints: semantic.headings.slice(0, 5),
        data: {},
      },
      actions: {
        buttons: [],
        forms: semantic.forms.map((f) => ({
          purpose: 'Unknown form',
          fields: f.fields,
        })),
        links: semantic.links.slice(0, 10).map((l) => ({
          text: l.text,
          purpose: 'Navigation',
        })),
      },
      suggestions: {
        nextSteps: ['Explore the page', 'Read the content'],
        relevantAreas: semantic.headings.slice(0, 3),
      },
    };
  }

  /**
   * Smart content extraction based on page type and user query
   */
  async extractContent(
    page: Page,
    analysis: PageAnalysis,
    userQuery: string
  ): Promise<Record<string, any>> {
    const semantic = await extractSemanticInfo(page);

    const prompt = `Extract specific content from this ${analysis.pageType} page.

**User Query**: "${userQuery}"

**Page Content**:
Title: ${semantic.title}
Description: ${semantic.description}

Key Headings:
${semantic.headings.join('\n')}

Key Paragraphs:
${semantic.paragraphs.join('\n\n')}

${semantic.tables.length > 0 ? `Tables:\n${JSON.stringify(semantic.tables, null, 2)}` : ''}

${semantic.lists.length > 0 ? `Lists:\n${semantic.lists.join('\n')}` : ''}

**Extract the information requested in the user query.**
Return as structured JSON with clear key-value pairs.
Focus on facts, numbers, dates, names, and specific data.`;

    const response = await this.fastLLM.invoke(prompt);
    const content = response.content as string;

    // Try to parse as JSON
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      // Not JSON, return as text
    }

    return { content };
  }
}
