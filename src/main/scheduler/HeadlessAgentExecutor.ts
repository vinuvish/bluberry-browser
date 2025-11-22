/**
 * Simplified Headless Agent Executor
 * Combines executor and orchestrator into one simple class
 */

import { Page } from 'puppeteer-core';
import { ChatOpenAI } from '@langchain/openai';
import { StateGraph, MemorySaver, Annotation, END } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { BaseMessage, HumanMessage } from '@langchain/core/messages';
import { HeadlessBrowserManager } from './HeadlessBrowserManager';
import { createHeadlessBrowserTools } from './HeadlessBrowserTools';
import { RETRY_LIMITS } from '../agent/constants';

const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  toolCalls: Annotation<number>({
    reducer: (x, y) => x + y,
    default: () => 0,
  }),
  goal: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => '',
  }),
  attempts: Annotation<number>({
    reducer: (x, y) => (y ?? 0) + (x ?? 0),
    default: () => 0,
  }),
  reflection: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => '',
  }),
});

/**
 * Simplified headless agent executor
 * Handles browser lifecycle, agent execution, and cleanup in one class
 */
export class HeadlessAgentExecutor {
  private browserManager: HeadlessBrowserManager;
  private llm: ChatOpenAI;

  constructor(browserManager: HeadlessBrowserManager) {
    this.browserManager = browserManager;
    this.llm = new ChatOpenAI({
      model: process.env.LLM_MODEL || 'gpt-4o',
      temperature: 0.1,
      openAIApiKey: process.env.OPENAI_API_KEY,
    });
  }

  /**
   * Execute a task autonomously
   */
  async execute(prompt: string): Promise<{ success: boolean; output: string }> {
    console.log(`\n🤖 Starting headless task: ${prompt.substring(0, 50)}...\n`);

    let page: Page | null = null;

    try {
      // Create page and tools
      page = await this.browserManager.createPage();
      const tools = createHeadlessBrowserTools(page);
      const app = this.buildGraph(tools);

      // Execute with LangGraph
      const config = {
        configurable: {
          thread_id: `headless-${Date.now()}`,
          recursionLimit: RETRY_LIMITS.MAX_AGENT_ITERATIONS * 2, // Allow more recursion for complex tasks
        }
      };
      const initialState = {
        messages: [new HumanMessage({ content: prompt })],
        toolCalls: 0,
        goal: prompt,
        attempts: 0,
        reflection: '',
      };

      let state = initialState;
      let iterations = 0;
      let lastReflection = '';

      while (iterations < RETRY_LIMITS.MAX_AGENT_ITERATIONS) {
        iterations++;
        console.log(`\n🔄 Iteration ${iterations}/${RETRY_LIMITS.MAX_AGENT_ITERATIONS}`);

        try {
          const result = await app.invoke(state, config);
          state = result as typeof state;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);

          // Handle recursion limit error gracefully
          if (errorMsg.includes('recursion limit') || errorMsg.includes('Recursion limit')) {
            console.warn(`⚠️  Recursion limit reached. Getting final state...`);
            // Try to get final output from current state
            const allMessages = state.messages;
            const lastAiMessage = allMessages.filter(m => m._getType() === 'ai').pop();
            const output = lastAiMessage?.content as string || 'Task execution reached recursion limit';

            console.log(`\n⚠️  Recursion limit reached. Final output: ${output.substring(0, 200)}...\n`);
            return { success: true, output };
          }

          // Re-throw other errors
          throw error;
        }

        // Update reflection if present
        if (state.reflection) {
          lastReflection = state.reflection;
          console.log(`💭 Reflection: ${lastReflection.substring(0, 150)}...`);
        }

        // Check if goal is achieved based on reflection
        const reflectionLower = state.reflection.toLowerCase();
        const goalAchieved = (reflectionLower.includes('goal achieved') ||
          reflectionLower.includes('status: yes') ||
          reflectionLower.includes('yes, goal achieved') ||
          (reflectionLower.includes('yes') && !reflectionLower.includes('no') && !reflectionLower.includes('partial'))) &&
          state.toolCalls > 0;

        if (goalAchieved) {
          // Get final output from last AI message
          const allMessages = state.messages;
          const lastAiMessage = allMessages.filter(m => m._getType() === 'ai').pop();
          const output = lastAiMessage?.content as string || 'Task completed successfully';

          console.log(`\n✅ Goal achieved! Task completed.\n`);
          console.log(`📊 Final output: ${output.substring(0, 200)}...\n`);
          return { success: true, output };
        }

        // Check if agent says task is complete without reflection
        const lastMessage = state.messages[state.messages.length - 1];
        if (lastMessage._getType() === 'ai') {
          const content = (lastMessage as any).content?.toLowerCase() || '';
          const hasToolCalls = (lastMessage as any).tool_calls?.length > 0;

          // Only end if agent explicitly says done AND has made progress (tool calls)
          if (!hasToolCalls && content.includes('task completed') && state.toolCalls > 0) {
            const output = (lastMessage as any).content as string || 'Task completed';
            console.log(`\n✅ Task completed\n`);
            return { success: true, output };
          }
        }

        // If reflection says END or goal NOT achieved, end gracefully
        if (reflectionLower.includes('nextaction: end') ||
          reflectionLower.includes('next: end') ||
          (reflectionLower.includes('goal not achieved') && reflectionLower.includes('end'))) {
          const allMessages = state.messages;
          const lastAiMessage = allMessages.filter(m => m._getType() === 'ai').pop();
          const output = lastAiMessage?.content as string || 'Task ended as requested';
          console.log(`\n⚠️  Task ended: ${lastReflection.substring(0, 100)}...\n`);
          return { success: true, output };
        }

        // Continue if reflection says to continue
        if (reflectionLower.includes('no') || reflectionLower.includes('partial') || reflectionLower.includes('continue')) {
          console.log(`🔄 Continuing execution...`);
          continue;
        }

        // If we've made significant progress but reflection is unclear, check if we should end
        if (state.toolCalls >= 10 && iterations >= 5 && !reflectionLower.includes('no')) {
          // Agent has made progress, check if we can extract a result
          const allMessages = state.messages;
          const lastAiMessage = allMessages.filter(m => m._getType() === 'ai').pop();
          const output = lastAiMessage?.content as string || 'Task execution completed';
          console.log(`\n✅ Task completed after ${iterations} iterations\n`);
          return { success: true, output };
        }
      }

      // Max iterations reached - get final output
      const allMessages = state.messages;
      const lastAiMessage = allMessages.filter(m => m._getType() === 'ai').pop();
      const output = lastAiMessage?.content as string || 'Task execution completed';

      // Even if max iterations reached, if we got some output, consider it success
      const hasOutput = Boolean(output && output.length > 20 && !output.toLowerCase().includes('failed'));
      console.log(`\n⚠️  Max iterations reached (${iterations}). Final output: ${output.substring(0, 200)}...\n`);
      return { success: hasOutput, output };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`❌ Task failed: ${errorMsg}\n`);

      // Try to extract any useful output from error context
      let errorOutput = `Task failed: ${errorMsg}`;
      if (errorMsg.includes('recursion limit')) {
        errorOutput = `Task reached recursion limit. This usually means the task was too complex or took too long. Consider breaking it into smaller tasks.`;
      }

      return { success: false, output: errorOutput };
    } finally {
      if (page) {
        try {
          await this.browserManager.closePage(page);
        } catch (e) {
          console.warn('⚠️  Error closing page:', e);
        }
      }
    }
  }

  /**
   * Build simplified LangGraph workflow
   */
  /**
   * Build simplified LangGraph workflow
   */
  private buildGraph(tools: any[]) {
    return new StateGraph(AgentState)
      .addNode('agent', async (state: typeof AgentState.State) => {
        const systemPrompt = `You are an autonomous browser agent running in headless mode.

Goal: ${state.goal || 'Complete the user request'}

INSTRUCTIONS:
1. Analyze the current state and progress.
2. Decide on the next best action.
3. Use analyze_website() first when navigating to new pages.
4. If the goal is achieved, output "TASK_COMPLETED" in your response.
5. ERROR RECOVERY:
   - If click_element fails, try describing the element differently or use text content.
   - If navigate fails, check the URL or try a different site.
   - If extraction fails, try a simpler query.

REFLECTION:
Before calling tools, briefly reflect on:
- Current status (progress towards goal)
- What worked/failed in previous steps
- What to do next

Execute the task efficiently.`;

        // Truncate and sanitize messages to prevent token limits and 400 errors
        const rawMessages = state.messages;
        const recentMessages = rawMessages.length > 10
          ? rawMessages.slice(-10)
          : rawMessages;

        // Sanitize messages to ensure valid OpenAI API history:
        // 1. Remove leading ToolMessages (orphans).
        // 2. Ensure AIMessages with tool_calls are followed by the CORRECT NUMBER of ToolMessages.
        //    If not, drop the AIMessage and the partial ToolMessages.
        const sanitizedMessages: BaseMessage[] = [];
        let i = 0;

        while (i < recentMessages.length) {
          const msg = recentMessages[i];

          if (msg._getType() === 'ai' && (msg as any).tool_calls?.length > 0) {
            const toolCalls = (msg as any).tool_calls;
            const numCalls = toolCalls.length;

            // Check if the next numCalls messages are ToolMessages
            let hasAllResponses = true;
            if (i + numCalls >= recentMessages.length) {
              hasAllResponses = false;
            } else {
              for (let j = 1; j <= numCalls; j++) {
                if (recentMessages[i + j]._getType() !== 'tool') {
                  hasAllResponses = false;
                  break;
                }
              }
            }

            if (hasAllResponses) {
              // Keep AIMessage and all its ToolMessages
              sanitizedMessages.push(msg);
              for (let j = 1; j <= numCalls; j++) {
                sanitizedMessages.push(recentMessages[i + j]);
              }
              i += numCalls; // Skip the ToolMessages we just added
            } else {
              console.warn(`⚠️ Dropping AIMessage with ${numCalls} tool_calls due to missing/incomplete responses.`);
              // We drop the AIMessage. 
              // The partial ToolMessages will be encountered in next iterations and dropped as orphans.
            }
          } else if (msg._getType() === 'tool') {
            // Orphan ToolMessage (because we handled valid ones in the AI block)
            console.warn('⚠️ Dropping orphan ToolMessage.');
          } else {
            // Human, System, or AI without tool_calls - keep
            sanitizedMessages.push(msg);
          }

          i++;
        }

        const response = await this.llm.bindTools(tools).invoke([
          new HumanMessage({ content: systemPrompt }),
          ...sanitizedMessages,
        ]);

        return {
          messages: [response],
          toolCalls: state.toolCalls + (response.tool_calls?.length || 0),
          attempts: state.attempts + 1,
        };
      })
      .addNode('tools', new ToolNode(tools))
      .addConditionalEdges('agent', (state) => {
        const lastMessage = state.messages[state.messages.length - 1];
        const content = (lastMessage as any).content as string;

        // Check for completion signal
        if (content && content.includes('TASK_COMPLETED')) {
          console.log('✅ Agent signaled completion');
          return END;
        }

        // Check max tool calls
        if (state.toolCalls >= RETRY_LIMITS.MAX_AGENT_ITERATIONS) {
          console.warn(`⚠️  Max tool calls (${RETRY_LIMITS.MAX_AGENT_ITERATIONS}) reached - ending`);
          return END;
        }

        return (lastMessage as any).tool_calls?.length > 0 ? 'tools' : END;
      })
      .addEdge('tools', 'agent')
      .setEntryPoint('agent')
      .compile({
        checkpointer: new MemorySaver(),
      });
  }
}
