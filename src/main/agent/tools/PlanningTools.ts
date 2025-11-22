/**
 * Planning Tools - LangChain Tool Pattern
 * Enables agents to break down complex tasks into structured plans
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { ChatOpenAI } from '@langchain/openai';

/**
 * Create planning tool that helps break down complex tasks
 * Uses LangChain's DynamicStructuredTool pattern
 */
export function createPlanningTool(_llm?: ChatOpenAI) {
  return new DynamicStructuredTool({
    name: 'create_plan',
    description: `Break down a complex task into discrete, actionable steps. Use this FIRST for complex multi-step tasks that require:
- Multiple distinct actions or phases
- Coordination across different data sources or websites
- Sequential dependencies between steps
- Data transformation or aggregation

DO NOT use for simple single-action tasks like "navigate to website" or "click button".`,

    schema: z.object({
      goal: z.string().describe('The overall goal to achieve'),
      steps: z.array(z.object({
        id: z.string().describe('Unique identifier for this step (e.g., "step_1", "step_2")'),
        description: z.string().describe('Clear, actionable description of what this step accomplishes'),
        dependencies: z.array(z.string()).optional().describe('IDs of steps that must complete before this one'),
      })).describe('Ordered list of steps to complete the goal. Each step should be discrete and verifiable.'),
    }),

    func: async ({ goal, steps }) => {
      // Validate plan structure
      if (steps.length === 0) {
        return JSON.stringify({
          success: false,
          error: 'Plan must contain at least one step',
        });
      }

      if (steps.length > 20) {
        return JSON.stringify({
          success: false,
          error: 'Plan cannot exceed 20 steps. Break down into smaller subtasks or use subagents.',
        });
      }

      // Validate dependencies
      const stepIds = new Set(steps.map(s => s.id));
      for (const step of steps) {
        if (step.dependencies) {
          for (const depId of step.dependencies) {
            if (!stepIds.has(depId)) {
              return JSON.stringify({
                success: false,
                error: `Step "${step.id}" depends on non-existent step "${depId}"`,
              });
            }
          }
        }
      }

      // Convert to execution plan format
      const plan = {
        goal,
        todos: steps.map(step => ({
          id: step.id,
          description: step.description,
          status: 'pending' as const,
          dependencies: step.dependencies || [],
        })),
        currentStepIndex: 0,
        createdAt: Date.now(),
      };

      return JSON.stringify({
        success: true,
        message: `Plan created with ${steps.length} steps`,
        plan,
        nextStep: steps[0].description,
      });
    },
  });
}

/**
 * Optional: Create a tool for updating plan progress
 * This allows the agent to mark steps as complete/failed
 */
export function createPlanUpdateTool() {
  return new DynamicStructuredTool({
    name: 'update_plan_step',
    description: 'Mark a step in the current plan as completed, failed, or skipped. Use after completing each planned step.',

    schema: z.object({
      stepId: z.string().describe('ID of the step to update'),
      status: z.enum(['completed', 'failed', 'skipped']).describe('New status for the step'),
      result: z.string().optional().describe('Optional result or output from this step'),
      error: z.string().optional().describe('Optional error message if step failed'),
    }),

    func: async ({ stepId, status, result, error }) => {
      // This will be handled by the orchestrator's state management
      return JSON.stringify({
        success: true,
        message: `Step "${stepId}" marked as ${status}`,
        stepId,
        status,
        result,
        error,
      });
    },
  });
}
