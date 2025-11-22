/**
 * Context Management Tools - LangChain Tool Pattern
 * Enables agents to save and retrieve large context data to/from persistent storage
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';

// Context storage directory
const getContextDir = () => path.join(app.getPath('userData'), 'agent-context');

/**
 * Create context management tools as an array
 * These tools allow agents to persist large data across operations
 */
export function createContextTools() {
  return [
    // Save context data
    new DynamicStructuredTool({
      name: 'save_context',
      description: `Save large context data to persistent storage. Use when:
- Context is too large for conversation history (>500 chars)
- You need to preserve data across multiple steps
- You're extracting data that will be used later
- You want to save intermediate results

The data will be available in future tool calls via load_context.`,

      schema: z.object({
        key: z.string().describe('Unique identifier for this context (e.g., "extracted_products", "user_data")'),
        data: z.string().describe('The data to save (can be JSON string, text, or any string data)'),
        description: z.string().optional().describe('Optional description of what this context contains'),
      }),

      func: async ({ key, data, description }) => {
        try {
          const contextDir = getContextDir();
          await fs.mkdir(contextDir, { recursive: true });

          // Create context metadata
          const metadata = {
            key,
            description: description || '',
            timestamp: Date.now(),
            size: data.length,
            dataType: typeof data,
          };

          // Save data file
          const dataPath = path.join(contextDir, `${key}.data.json`);
          await fs.writeFile(dataPath, data, 'utf-8');

          // Save metadata file
          const metaPath = path.join(contextDir, `${key}.meta.json`);
          await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf-8');

          return JSON.stringify({
            success: true,
            message: `Context "${key}" saved successfully`,
            path: dataPath,
            size: data.length,
            timestamp: metadata.timestamp,
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: `Failed to save context: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      },
    }),

    // Load context data
    new DynamicStructuredTool({
      name: 'load_context',
      description: `Load previously saved context data by key. Use this to retrieve data you saved earlier with save_context.`,

      schema: z.object({
        key: z.string().describe('The context key to load (must match a previously saved key)'),
      }),

      func: async ({ key }) => {
        try {
          const contextDir = getContextDir();
          const dataPath = path.join(contextDir, `${key}.data.json`);
          const metaPath = path.join(contextDir, `${key}.meta.json`);

          // Check if files exist
          try {
            await fs.access(dataPath);
          } catch {
            return JSON.stringify({
              success: false,
              error: `Context "${key}" not found. Use list_contexts to see available contexts.`,
            });
          }

          // Read data and metadata
          const data = await fs.readFile(dataPath, 'utf-8');
          const metadataStr = await fs.readFile(metaPath, 'utf-8');
          const metadata = JSON.parse(metadataStr);

          return JSON.stringify({
            success: true,
            message: `Context "${key}" loaded successfully`,
            data: data,
            metadata: {
              description: metadata.description,
              timestamp: metadata.timestamp,
              size: metadata.size,
            },
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: `Failed to load context: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      },
    }),

    // List all saved contexts
    new DynamicStructuredTool({
      name: 'list_contexts',
      description: `List all available saved contexts. Use this to see what context data is available to load.`,

      schema: z.object({}),

      func: async () => {
        try {
          const contextDir = getContextDir();

          // Create directory if it doesn't exist
          try {
            await fs.mkdir(contextDir, { recursive: true });
          } catch {
            // Directory might already exist
          }

          // Read all files
          const files = await fs.readdir(contextDir);

          // Filter for metadata files
          const metaFiles = files.filter(f => f.endsWith('.meta.json'));

          if (metaFiles.length === 0) {
            return JSON.stringify({
              success: true,
              message: 'No saved contexts found',
              contexts: [],
            });
          }

          // Read all metadata
          const contexts = await Promise.all(
            metaFiles.map(async (metaFile) => {
              const metaPath = path.join(contextDir, metaFile);
              const metadataStr = await fs.readFile(metaPath, 'utf-8');
              const metadata = JSON.parse(metadataStr);
              return {
                key: metadata.key,
                description: metadata.description,
                timestamp: metadata.timestamp,
                size: metadata.size,
                age: Date.now() - metadata.timestamp,
              };
            })
          );

          // Sort by timestamp (newest first)
          contexts.sort((a, b) => b.timestamp - a.timestamp);

          return JSON.stringify({
            success: true,
            message: `Found ${contexts.length} saved context(s)`,
            contexts,
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: `Failed to list contexts: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      },
    }),

    // Delete a context
    new DynamicStructuredTool({
      name: 'delete_context',
      description: `Delete a saved context by key. Use this to clean up contexts you no longer need.`,

      schema: z.object({
        key: z.string().describe('The context key to delete'),
      }),

      func: async ({ key }) => {
        try {
          const contextDir = getContextDir();
          const dataPath = path.join(contextDir, `${key}.data.json`);
          const metaPath = path.join(contextDir, `${key}.meta.json`);

          // Check if files exist
          try {
            await fs.access(dataPath);
          } catch {
            return JSON.stringify({
              success: false,
              error: `Context "${key}" not found`,
            });
          }

          // Delete both files
          await fs.unlink(dataPath);
          await fs.unlink(metaPath);

          return JSON.stringify({
            success: true,
            message: `Context "${key}" deleted successfully`,
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: `Failed to delete context: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      },
    }),
  ];
}

/**
 * Cleanup old contexts (utility function, can be called periodically)
 */
export async function cleanupOldContexts(maxAgeDays: number = 30): Promise<void> {
  try {
    const contextDir = getContextDir();
    const files = await fs.readdir(contextDir);
    const metaFiles = files.filter(f => f.endsWith('.meta.json'));

    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    for (const metaFile of metaFiles) {
      const metaPath = path.join(contextDir, metaFile);
      const metadataStr = await fs.readFile(metaPath, 'utf-8');
      const metadata = JSON.parse(metadataStr);

      if (now - metadata.timestamp > maxAgeMs) {
        const key = metadata.key;
        const dataPath = path.join(contextDir, `${key}.data.json`);

        // Delete old context
        await fs.unlink(dataPath);
        await fs.unlink(metaPath);

        console.log(`🗑️  Cleaned up old context: ${key}`);
      }
    }
  } catch (error) {
    console.error('Failed to cleanup old contexts:', error);
  }
}
