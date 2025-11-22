/**
 * Persistent Checkpointer - File-based LangGraph Checkpoint Saver
 * Implements LangGraph's checkpointing interface for persistent memory across sessions
 */

import { BaseCheckpointSaver } from '@langchain/langgraph';
import type { Checkpoint, CheckpointMetadata, CheckpointTuple } from '@langchain/langgraph';
import * as fs from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';

/**
 * File-based checkpoint saver that persists agent state to disk
 * This enables agent memory to survive application restarts
 */
export class FileCheckpointer extends BaseCheckpointSaver {
  private storageDir: string;

  constructor(storagePath?: string) {
    super();
    this.storageDir = storagePath || path.join(app.getPath('userData'), 'agent-memory');
  }

  /**
   * Initialize storage directory
   */
  private async ensureStorageDir(): Promise<void> {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create storage directory:', error);
    }
  }

  /**
   * Get file path for a specific checkpoint
   */
  private getCheckpointPath(threadId: string, checkpointId?: string): string {
    const filename = checkpointId
      ? `${threadId}_${checkpointId}.json`
      : `${threadId}_latest.json`;
    return path.join(this.storageDir, filename);
  }

  /**
   * Get metadata file path for a thread
   */
  private getMetadataPath(threadId: string): string {
    return path.join(this.storageDir, `${threadId}_metadata.json`);
  }

  /**
   * Put writes (required by BaseCheckpointSaver interface)
   * This method stores pending writes that will be applied in the next checkpoint
   */
  async putWrites(
    config: { configurable?: { thread_id?: string; checkpoint_id?: string } },
    writes: Array<any>,
    taskId: string
  ): Promise<void> {
    // For this simple implementation, we'll just log the writes
    // In a more complex implementation, you might want to store these separately
    const threadId = config.configurable?.thread_id || 'default';
    console.log(`💾 Storing ${writes.length} writes for thread ${threadId}, task ${taskId}`);

    // You can extend this to actually persist the writes if needed
    // For now, we'll rely on the checkpoint mechanism to capture state
  }

  /**
   * Save a checkpoint to disk
   */
  async put(
    config: { configurable?: { thread_id?: string; checkpoint_id?: string } },
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<{ configurable: { thread_id: string; checkpoint_id: string } }> {
    await this.ensureStorageDir();

    const threadId = config.configurable?.thread_id || 'default';
    const checkpointId = checkpoint.id || `checkpoint_${Date.now()}`;

    try {
      // Save checkpoint data
      const checkpointPath = this.getCheckpointPath(threadId, checkpointId);
      const checkpointData = {
        id: checkpointId,
        checkpoint,
        metadata: {
          ...metadata,
          saved_at: Date.now(),
        },
      };

      await fs.writeFile(
        checkpointPath,
        JSON.stringify(checkpointData, null, 2),
        'utf-8'
      );

      // Update latest checkpoint reference
      const latestPath = this.getCheckpointPath(threadId);
      await fs.writeFile(
        latestPath,
        JSON.stringify(checkpointData, null, 2),
        'utf-8'
      );

      // Update thread metadata
      await this.updateThreadMetadata(threadId, checkpointId, metadata);

      console.log(`💾 Checkpoint saved: ${threadId}/${checkpointId}`);

      return {
        configurable: {
          thread_id: threadId,
          checkpoint_id: checkpointId,
        },
      };
    } catch (error) {
      console.error('Failed to save checkpoint:', error);
      throw error;
    }
  }

  /**
   * Load a checkpoint from disk
   */
  async getTuple(
    config: { configurable?: { thread_id?: string; checkpoint_id?: string } }
  ): Promise<CheckpointTuple | undefined> {
    await this.ensureStorageDir();

    const threadId = config.configurable?.thread_id || 'default';
    const checkpointId = config.configurable?.checkpoint_id;

    try {
      const checkpointPath = this.getCheckpointPath(threadId, checkpointId);

      // Check if file exists
      try {
        await fs.access(checkpointPath);
      } catch {
        console.log(`No checkpoint found for ${threadId}${checkpointId ? `/${checkpointId}` : ''}`);
        return undefined;
      }

      // Read checkpoint data
      const data = await fs.readFile(checkpointPath, 'utf-8');
      const checkpointData = JSON.parse(data);

      console.log(`📂 Checkpoint loaded: ${threadId}${checkpointId ? `/${checkpointId}` : ''}`);

      return {
        config: {
          configurable: {
            thread_id: threadId,
            checkpoint_id: checkpointData.id,
          },
        },
        checkpoint: checkpointData.checkpoint,
        metadata: checkpointData.metadata,
        parentConfig: undefined, // We don't track parent checkpoints in this simple implementation
      };
    } catch (error) {
      console.error('Failed to load checkpoint:', error);
      return undefined;
    }
  }

  /**
   * List all checkpoints for a thread
   */
  async *list(
    config: { configurable?: { thread_id?: string } }
  ): AsyncGenerator<CheckpointTuple> {
    await this.ensureStorageDir();

    const threadId = config.configurable?.thread_id;

    try {
      const files = await fs.readdir(this.storageDir);

      // Filter files for this thread (or all threads if no threadId specified)
      const checkpointFiles = files.filter(file => {
        if (!file.endsWith('.json') || file.endsWith('_metadata.json') || file.endsWith('_latest.json')) {
          return false;
        }
        return threadId ? file.startsWith(`${threadId}_`) : true;
      });

      // Load and yield each checkpoint
      for (const file of checkpointFiles) {
        try {
          const filePath = path.join(this.storageDir, file);
          const data = await fs.readFile(filePath, 'utf-8');
          const checkpointData = JSON.parse(data);

          // Extract thread ID from filename
          const fileThreadId = file.split('_')[0];

          yield {
            config: {
              configurable: {
                thread_id: fileThreadId,
                checkpoint_id: checkpointData.id,
              },
            },
            checkpoint: checkpointData.checkpoint,
            metadata: checkpointData.metadata,
            parentConfig: undefined,
          };
        } catch (error) {
          console.warn(`Failed to load checkpoint file ${file}:`, error);
        }
      }
    } catch (error) {
      console.error('Failed to list checkpoints:', error);
    }
  }

  /**
   * Update thread metadata
   */
  private async updateThreadMetadata(
    threadId: string,
    checkpointId: string,
    metadata: CheckpointMetadata
  ): Promise<void> {
    const metadataPath = this.getMetadataPath(threadId);

    try {
      let threadMetadata: any = {
        thread_id: threadId,
        created_at: Date.now(),
        checkpoints: [],
      };

      // Try to load existing metadata
      try {
        const existing = await fs.readFile(metadataPath, 'utf-8');
        threadMetadata = JSON.parse(existing);
      } catch {
        // File doesn't exist yet
      }

      // Add new checkpoint to list
      threadMetadata.checkpoints.push({
        checkpoint_id: checkpointId,
        timestamp: Date.now(),
        metadata,
      });

      threadMetadata.updated_at = Date.now();

      // Save updated metadata
      await fs.writeFile(
        metadataPath,
        JSON.stringify(threadMetadata, null, 2),
        'utf-8'
      );
    } catch (error) {
      console.warn('Failed to update thread metadata:', error);
    }
  }

  /**
   * Cleanup old checkpoints (utility method)
   */
  async cleanup(maxAgeDays: number = 90): Promise<void> {
    await this.ensureStorageDir();

    try {
      const files = await fs.readdir(this.storageDir);
      const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
      const now = Date.now();

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = path.join(this.storageDir, file);

        try {
          const data = await fs.readFile(filePath, 'utf-8');
          const checkpointData = JSON.parse(data);

          const savedAt = checkpointData.metadata?.saved_at || 0;
          if (now - savedAt > maxAgeMs) {
            await fs.unlink(filePath);
            console.log(`🗑️  Cleaned up old checkpoint: ${file}`);
          }
        } catch (error) {
          console.warn(`Failed to process file ${file}:`, error);
        }
      }
    } catch (error) {
      console.error('Failed to cleanup old checkpoints:', error);
    }
  }

  /**
   * Delete all checkpoints for a thread
   */
  async deleteThread(threadId: string): Promise<void> {
    await this.ensureStorageDir();

    try {
      const files = await fs.readdir(this.storageDir);
      const threadFiles = files.filter(file => file.startsWith(`${threadId}_`));

      for (const file of threadFiles) {
        const filePath = path.join(this.storageDir, file);
        await fs.unlink(filePath);
      }

      console.log(`🗑️  Deleted all checkpoints for thread: ${threadId}`);
    } catch (error) {
      console.error('Failed to delete thread checkpoints:', error);
    }
  }
}
