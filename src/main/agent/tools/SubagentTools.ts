/**
 * Subagent Tools - LangChain Tool Pattern
 * Enables agents to delegate isolated subtasks to specialized subagents
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { Window } from '../../Window';

/**
 * Create subagent delegation tool
 * Allows the main agent to spawn isolated subagents for specific subtasks
 *
 * @param window - The browser window instance
 * @param getOrchestrator - Function to create a new orchestrator instance (to avoid circular dependency)
 */
export function createSubagentTool(
  _window: Window,
  getOrchestrator: () => any // Type will be AgentOrchestrator but we use any to avoid circular import
) {
  return new DynamicStructuredTool({
    name: 'spawn_subagent',
    description: `Delegate a specific, isolated subtask to a specialized subagent. Use this when:
- The subtask is independent and self-contained
- You need to isolate the subtask's execution context
- The subtask might fail and you don't want it to affect the main task
- You want parallel execution of independent tasks

DO NOT use for tasks that require shared state with the main agent.

Examples of good subagent tasks:
- "Extract product details from this specific URL"
- "Check if this email is valid by navigating to the provider"
- "Get the current stock price for AAPL"

Examples of bad subagent tasks:
- "Continue the current workflow" (not isolated)
- "Use the data I just extracted" (requires shared state)`,

    schema: z.object({
      subtask: z.string().describe('Clear, specific description of the subtask to delegate. Should be self-contained.'),
      context: z.string().optional().describe('Optional context or data the subagent needs to complete the task'),
      taskId: z.string().optional().describe('Optional unique identifier for tracking this subagent task'),
    }),

    func: async ({ subtask, context, taskId }) => {
      try {
        console.log(`\n🤖 Spawning subagent for task: "${subtask}"\n`);

        // Create a new orchestrator instance for the subagent
        const subagent = getOrchestrator();

        // Build the full task prompt
        const fullTask = context
          ? `Context: ${context}\n\nTask: ${subtask}`
          : subtask;

        // Execute the subtask in isolation
        const startTime = Date.now();
        const result = await subagent.executeSingle(fullTask);
        const duration = Date.now() - startTime;

        console.log(`\n✅ Subagent completed in ${duration}ms\n`);

        // Return structured result
        return JSON.stringify({
          success: result.success,
          message: result.success
            ? `Subagent completed successfully in ${duration}ms`
            : `Subagent failed: ${result.error || 'Unknown error'}`,
          subtask,
          taskId: taskId || `subagent_${Date.now()}`,
          output: result.output,
          error: result.error,
          duration,
          data: result.data,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('❌ Subagent execution failed:', errorMessage);

        return JSON.stringify({
          success: false,
          message: 'Subagent execution failed',
          subtask,
          taskId: taskId || `subagent_${Date.now()}`,
          error: errorMessage,
        });
      }
    },
  });
}

/**
 * Alternative: Create a parallel subagent tool for executing multiple subtasks concurrently
 * This can be added later for advanced use cases
 */
export function createParallelSubagentTool(
  _window: Window,
  getOrchestrator: () => any
) {
  return new DynamicStructuredTool({
    name: 'spawn_parallel_subagents',
    description: `Execute multiple independent subtasks in parallel using subagents.
Only use when subtasks are completely independent and don't share state.`,

    schema: z.object({
      subtasks: z.array(z.object({
        id: z.string(),
        task: z.string(),
        context: z.string().optional(),
      })).describe('Array of independent subtasks to execute in parallel'),
    }),

    func: async ({ subtasks }) => {
      try {
        console.log(`\n🤖 Spawning ${subtasks.length} parallel subagents\n`);

        const startTime = Date.now();

        // Execute all subtasks in parallel
        const results = await Promise.all(
          subtasks.map(async ({ id, task, context }) => {
            try {
              const subagent = getOrchestrator();
              const fullTask = context ? `${context}\n\n${task}` : task;
              const result = await subagent.executeSingle(fullTask);

              return {
                id,
                task,
                success: result.success,
                output: result.output,
                error: result.error,
              };
            } catch (error) {
              return {
                id,
                task,
                success: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          })
        );

        const duration = Date.now() - startTime;
        const successCount = results.filter(r => r.success).length;

        console.log(`\n✅ Parallel subagents completed: ${successCount}/${subtasks.length} succeeded in ${duration}ms\n`);

        return JSON.stringify({
          success: successCount === subtasks.length,
          message: `Completed ${successCount}/${subtasks.length} subtasks in ${duration}ms`,
          results,
          duration,
        });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
}
