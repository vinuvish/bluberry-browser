/**
 * Agent Orchestrator - Using LangGraph for State Management
 */

import { ChatOpenAI } from '@langchain/openai';
import { StateGraph, END, Annotation } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { BaseMessage, HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { createBrowserTools } from '../tools/BrowserTools';
import { createDocumentTools } from '../tools/DocumentTools';
import { createPlanningTool, createPlanUpdateTool } from '../tools/PlanningTools';
import { createContextTools } from '../tools/ContextTools';
import { createSubagentTool } from '../tools/SubagentTools';
import { FileCheckpointer } from '../utils/PersistentCheckpointer';
import type { Window } from '../../Window';
import type { Tab } from '../../Tab';
import type { TaskResult, TaskPlan, SubagentTask } from '../types';
import { RETRY_LIMITS, PLANNING } from '../constants';

/**
 * Enhanced state structure for autonomous agent with planning capabilities
 */
const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  toolCalls: Annotation<number>({
    reducer: (x, y) => x + y,
    default: () => 0,
  }),
  tabId: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => '',
  }),
  goal: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => '',
  }),
  attempts: Annotation<number>({
    reducer: (x, y) => (y ?? 0) + (x ?? 0),
    default: () => 0,
  }),
  lastAction: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => '',
  }),
  successIndicators: Annotation<string[]>({
    reducer: (x, y) => [...(x || []), ...(y || [])],
    default: () => [],
  }),
  failedActions: Annotation<string[]>({
    reducer: (x, y) => [...(x || []), ...(y || [])],
    default: () => [],
  }),
  reflection: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => '',
  }),
  recentActions: Annotation<string[]>({
    reducer: (x, y) => {
      const combined = [...(x || []), ...(y || [])];
      // Keep only last 10 actions for loop detection
      return combined.slice(-10);
    },
    default: () => [],
  }),
  // DeepAgents-style planning state
  plan: Annotation<TaskPlan | null>({
    reducer: (x, y) => y ?? x, // Replace strategy for plan
    default: () => null,
  }),
  // Context files tracking (persistent storage keys)
  contextFiles: Annotation<Map<string, string>>({
    reducer: (x, y) => {
      const merged = new Map(x || new Map());
      if (y) {
        y.forEach((value, key) => merged.set(key, value));
      }
      return merged;
    },
    default: () => new Map(),
  }),
  // Subagent tracking
  subagents: Annotation<SubagentTask[]>({
    reducer: (x, y) => [...(x || []), ...(y || [])],
    default: () => [],
  }),
});

export class AgentOrchestrator {
  private llm: ChatOpenAI;
  private tools: any[];
  private app: any; // Compiled StateGraph
  private window: Window;
  private threadId: string;
  private createdTabs: Tab[] = []; // Track tabs created during execution
  private originalActiveTab: Tab | null = null;
  private subagentDepth: number = 0; // Track nesting depth to prevent infinite recursion

  constructor(window: Window, specificTab?: Tab, subagentDepth: number = 0) {
    this.subagentDepth = subagentDepth;
    this.window = window;
    this.threadId = `session-${Date.now()}`;
    this.originalActiveTab = specificTab || window.activeTab || null;

    // Initialize LLM
    this.llm = new ChatOpenAI({
      model: process.env.LLM_MODEL || 'gpt-4o',
      temperature: 0.1,
      openAIApiKey: process.env.OPENAI_API_KEY,
    });

    // Create browser automation tools with tab tracking
    const browserTools = createBrowserTools(window, specificTab, (tab: Tab) => {
      // Track created tabs
      if (tab.id !== this.originalActiveTab?.id) {
        this.createdTabs.push(tab);
        console.log(`📝 Tracking created tab: ${tab.id}`);
      }
    });

    // Create planning tool with dedicated LLM
    const planningLLM = new ChatOpenAI({
      model: PLANNING.PLAN_LLM_MODEL,
      temperature: PLANNING.PLAN_TEMPERATURE,
      openAIApiKey: process.env.OPENAI_API_KEY,
    });
    const planningTool = createPlanningTool(planningLLM);
    const planUpdateTool = createPlanUpdateTool();

    // Create context management tools
    const contextTools = createContextTools();

    // Create document generation tools (Excel, Word, PDF)
    const documentTools = createDocumentTools();

    // Create subagent tool with orchestrator factory (only if not too deep)
    // Limit subagent depth to 2 levels to prevent infinite recursion and API exhaustion
    const MAX_SUBAGENT_DEPTH = 2;
    const toolsList: any[] = [
      planningTool,
      planUpdateTool,
      ...contextTools,
      ...documentTools,
      ...browserTools,
    ];

    // Only add subagent tool if we haven't exceeded max depth
    if (this.subagentDepth < MAX_SUBAGENT_DEPTH) {
      const subagentTool = createSubagentTool(
        window,
        () => new AgentOrchestrator(window, specificTab, this.subagentDepth + 1)
      );
      toolsList.push(subagentTool);
      console.log(`✅ Subagent tool enabled (depth: ${this.subagentDepth}/${MAX_SUBAGENT_DEPTH})`);
    } else {
      console.log(`⚠️  Subagent tool disabled - max depth (${MAX_SUBAGENT_DEPTH}) reached`);
    }

    this.tools = toolsList;

    // Build the StateGraph
    this.app = this.buildGraph();

    const depthInfo = this.subagentDepth > 0 ? ` [Subagent Depth: ${this.subagentDepth}]` : '';
    console.log(`✅ Agent Orchestrator initialized with ${this.tools.length} tools (including planning & context management)${depthInfo}`);
  }

  /**
   * Build the LangGraph StateGraph with autonomous loop and self-reflection
   */
  private buildGraph() {
    // Create the graph
    const workflow = new StateGraph(AgentState)
      // Add agent node - calls LLM with tools and manages plan state
      .addNode('agent', async (state: typeof AgentState.State) => {
        const { messages, goal, plan } = state;

        // Build system prompt with plan context
        const systemPrompt = this.buildSystemPrompt(goal, plan);
        const systemMessage = new HumanMessage({ content: systemPrompt });
        
        // If we have a plan with current step, add a reminder to the messages
        const messagesWithReminder = [...messages];
        if (plan && plan.todos && plan.todos.length > 0) {
          const currentStep = plan.todos[plan.currentStepIndex];
          if (currentStep && currentStep.status === 'pending') {
            // Add a gentle reminder about the current step
            const reminder = new HumanMessage({
              content: `REMINDER: You are working on step ${plan.currentStepIndex + 1}/${plan.todos.length}: "${currentStep.description}". Complete this step and then move to the next one.`,
            });
            messagesWithReminder.push(reminder);
          }
        }

        // Invoke LLM with tools (including reminder if needed)
        const response = await this.llm.bindTools(this.tools).invoke([systemMessage, ...messagesWithReminder]);

        // Track last action
        const lastAction = response.tool_calls?.[0]?.name || 'thinking';
        const toolNames = response.tool_calls?.map((tc: any) => tc.name) || [];

        // Check if agent created a plan using create_plan tool
        let updatedPlan = plan;
        const createPlanCalls = response.tool_calls?.filter((tc: any) => tc.name === 'create_plan') || [];
        if (createPlanCalls.length > 0 && !plan) {
          // Plan will be created by the tool, we'll get it from tool response later
          // For now, just note that planning is in progress
          console.log('📋 Agent is creating a plan...');
        }

        // Update plan progress if plan exists
        updatedPlan = this.updatePlanProgress(plan, response);

        return {
          messages: [response],
          toolCalls: state.toolCalls + (response.tool_calls?.length || 0),
          attempts: state.attempts + 1,
          lastAction,
          recentActions: toolNames.length > 0 ? toolNames : [lastAction],
          plan: updatedPlan,
        };
      })

      // Add tools node - executes tools with error handling and plan extraction
      .addNode('tools', async (state: typeof AgentState.State) => {
        const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
        const toolCalls = lastMessage.tool_calls || [];

        try {
          // Use ToolNode to execute tools
          const toolNode = new ToolNode(this.tools);
          const result = await toolNode.invoke(state);

          // Validate that we got responses for all tool calls
          const resultMessages = result.messages || [];
          const toolMessageIds = resultMessages
            .filter((msg: any) => msg.constructor.name === 'ToolMessage')
            .map((msg: any) => msg.tool_call_id);

          // Find any tool calls that didn't get responses
          const missingResponses = toolCalls.filter(
            (tc: any) => !toolMessageIds.includes(tc.id)
          );

          if (missingResponses.length > 0) {
            console.error('❌ Missing tool responses for:', missingResponses.map((tc: any) => tc.name));

            // Create error responses for missing tool calls
            const errorMessages = missingResponses.map((toolCall: any) =>
              new ToolMessage({
                content: `Error: Tool ${toolCall.name} did not return a response`,
                tool_call_id: toolCall.id,
                name: toolCall.name,
              })
            );

            // Combine existing results with error messages
            return {
              messages: [...resultMessages, ...errorMessages]
            };
          }

          // Extract plan from create_plan tool response
          let newPlan = state.plan;
          for (const msg of resultMessages) {
            if (msg.constructor.name === 'ToolMessage' && msg.name === 'create_plan') {
              try {
                const response = JSON.parse(msg.content);
                if (response.success && response.plan) {
                  newPlan = response.plan;
                  console.log(`📋 Plan created with ${response.plan.todos.length} steps`);
                }
              } catch (e) {
                // Failed to parse plan response
                console.warn('Failed to parse create_plan response:', e);
              }
            }
          }

          // Auto-detect step completion from tool responses
          // If we have a plan and tools executed successfully, auto-advance
          if (newPlan && newPlan.todos && newPlan.todos.length > 0) {
            newPlan = this.autoAdvancePlan(newPlan, resultMessages, toolCalls);
          }

          return {
            messages: resultMessages,
            plan: newPlan,
          };
        } catch (error) {
          // If ToolNode fails completely, create error responses for all pending tool calls
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error('❌ Tool execution error:', errorMsg);

          // Create error ToolMessages for each tool call
          const errorMessages = toolCalls.map((toolCall: any) =>
            new ToolMessage({
              content: `Error executing ${toolCall.name}: ${errorMsg}`,
              tool_call_id: toolCall.id,
              name: toolCall.name,
            })
          );

          return {
            messages: errorMessages
          };
        }
      })

      // Add conditional routing from agent
      .addConditionalEdges('agent', this.shouldContinue, {
        continue: 'tools',
        end: END,
      })

      // After tools execute, go back to agent to decide next action
      .addEdge('tools', 'agent')

      // Set entry point
      .setEntryPoint('agent');

    // Compile with persistent checkpointer for memory across sessions
    return workflow.compile({
      checkpointer: new FileCheckpointer(), // Enables persistent agent memory
    });
  }

  /**
   * Auto-advance plan when steps are implicitly complete
   * Detects successful tool executions and marks current step as complete
   */
  private autoAdvancePlan(
    plan: TaskPlan,
    toolMessages: any[],
    toolCalls: any[]
  ): TaskPlan {
    if (!plan || !plan.todos || plan.todos.length === 0) {
      return plan;
    }

    // Get current step
    const currentStepIndex = plan.currentStepIndex;
    if (currentStepIndex >= plan.todos.length) {
      return plan; // Already past all steps
    }

    const currentStep = plan.todos[currentStepIndex];
    if (currentStep.status !== 'pending') {
      return plan; // Step already marked
    }

    // Check if we have successful tool executions (not planning or update tools)
    const nonPlanningTools = toolCalls.filter(
      (tc: any) => tc.name !== 'create_plan' && tc.name !== 'update_plan_step'
    );

    if (nonPlanningTools.length === 0) {
      return plan; // No actual work done yet
    }

    // Check if tool responses indicate success
    const successfulTools = toolMessages.filter((msg: any) => {
      if (msg.constructor.name !== 'ToolMessage') return false;
      const content = String(msg.content || '').toLowerCase();
      // Success indicators
      return (
        !content.includes('error') &&
        !content.includes('failed') &&
        !content.includes('cannot') &&
        (content.includes('success') ||
          content.includes('completed') ||
          content.includes('created') ||
          content.length > 10) // Has meaningful output
      );
    });

    // If we have successful tool executions, auto-advance the current step
    if (successfulTools.length > 0) {
      const updatedPlan = { ...plan };
      updatedPlan.todos = [...plan.todos];
      updatedPlan.todos[currentStepIndex] = {
        ...currentStep,
        status: 'completed' as const,
        result: `Auto-completed after ${successfulTools.length} successful tool execution(s)`,
      };

      // Move to next step
      updatedPlan.currentStepIndex = currentStepIndex + 1;

      console.log(
        `✅ Auto-advanced plan: Step "${currentStep.id}" marked complete (${successfulTools.length} successful tools)`
      );

      // Check if plan is complete
      if (this.isPlanComplete(updatedPlan)) {
        updatedPlan.completedAt = Date.now();
        console.log('✅ Plan auto-completed - all steps finished');
      }

      return updatedPlan;
    }

    return plan;
  }

  /**
   * Update plan progress based on tool responses
   */
  private updatePlanProgress(plan: TaskPlan | null, aiMessage: AIMessage): TaskPlan | null {
    if (!plan || !plan.todos || plan.todos.length === 0) {
      return plan;
    }

    // Check if agent called update_plan_step tool
    const updateCalls = aiMessage.tool_calls?.filter((tc: any) => tc.name === 'update_plan_step') || [];

    if (updateCalls.length === 0) {
      return plan; // No explicit updates (auto-advance will handle it)
    }

    // Clone plan to avoid mutation
    const updatedPlan = { ...plan };
    updatedPlan.todos = [...plan.todos];

    // Apply updates from tool calls
    for (const call of updateCalls) {
      const { stepId, status, result, error } = call.args;
      const stepIndex = updatedPlan.todos.findIndex(todo => todo.id === stepId);

      if (stepIndex !== -1) {
        updatedPlan.todos[stepIndex] = {
          ...updatedPlan.todos[stepIndex],
          status,
          result,
          error,
        };

        // Move to next step if current was completed
        if (status === 'completed' && stepIndex === updatedPlan.currentStepIndex) {
          updatedPlan.currentStepIndex++;
        }
      }
    }

    // Check if plan is complete
    if (this.isPlanComplete(updatedPlan)) {
      updatedPlan.completedAt = Date.now();
    }

    return updatedPlan;
  }

  /**
   * Check if execution plan is complete
   */
  private isPlanComplete(plan: TaskPlan | null): boolean {
    if (!plan || !plan.todos || plan.todos.length === 0) {
      return false;
    }

    // All todos must be in a terminal state (completed, failed, or skipped)
    return plan.todos.every(todo =>
      todo.status === 'completed' ||
      todo.status === 'failed' ||
      todo.status === 'skipped'
    );
  }

  /**
   * Get current step from plan
   */
  private getCurrentStep(plan: TaskPlan | null): string | null {
    if (!plan || !plan.todos || plan.todos.length === 0) {
      return null;
    }

    if (plan.currentStepIndex >= plan.todos.length) {
      return null; // Plan complete
    }

    return plan.todos[plan.currentStepIndex].description;
  }

  /**
   * Get plan summary for system prompt
   */
  private getPlanSummary(plan: TaskPlan | null): string {
    if (!plan || !plan.todos || plan.todos.length === 0) {
      return 'No plan created yet. Consider using create_plan for complex multi-step tasks.';
    }

    const completedCount = plan.todos.filter(t => t.status === 'completed').length;
    const totalCount = plan.todos.length;
    const currentStep = this.getCurrentStep(plan);

    let summary = `📋 Plan Progress: ${completedCount}/${totalCount} steps completed\n\n`;

    summary += plan.todos.map((todo, idx) => {
      const statusEmoji = {
        pending: '⏳',
        completed: '✅',
        failed: '❌',
        skipped: '⏭️',
      }[todo.status] || '❓';

      const isCurrent = idx === plan.currentStepIndex;
      const prefix = isCurrent ? '👉 ' : '   ';

      return `${prefix}${statusEmoji} ${todo.id}: ${todo.description}`;
    }).join('\n');

    if (currentStep) {
      summary += `\n\n🎯 Current Step: ${currentStep}`;
    } else if (this.isPlanComplete(plan)) {
      summary += '\n\n✅ Plan Complete!';
    }

    return summary;
  }

  /**
   * Build system prompt for the agent with planning capabilities
   */
  private buildSystemPrompt(goal: string, plan?: TaskPlan | null): string {
    // Get plan summary if plan exists
    const planSection = plan ? `\n\n${this.getPlanSummary(plan)}` : '';

    // Auto-generate tool descriptions from LangChain tools
    const toolDescriptions = this.tools.map(tool =>
      `- ${tool.name}: ${tool.description}`
    ).join('\n');

    const basePrompt = `You are an AUTONOMOUS browser automation agent with planning capabilities.

🎯 YOUR GOAL: ${goal || 'Complete the user request'}${planSection}

⚠️ CRITICAL: You are NOT done until you have created the requested file (Excel/Word/PDF)!

🚫 ANTI-LOOP RULES:
- DO NOT repeatedly extract the same data
- DO NOT navigate to the same page multiple times unnecessarily
- DO NOT call analyze_website() more than once per page
- If you've extracted data, MOVE FORWARD to creating the file
- If a tool says "file created successfully", you're DONE - stop immediately
- Maximum 2-3 extraction attempts per page, then move on

📋 PLANNING WORKFLOW (For complex multi-step tasks):
1. **create_plan(goal, steps)** - Use this FIRST for complex tasks requiring 3+ steps
   - Break down the goal into discrete, actionable steps
   - Define dependencies between steps
   - Get a structured plan to follow

2. **Follow the plan** - Execute each step systematically
   - Work on current step (shown in plan progress)
   - Use update_plan_step to mark steps complete/failed
   - Move to next step automatically

3. **Context Management** (For large data):
   - save_context(key, data): Save extracted data for later use
   - load_context(key): Retrieve previously saved data
   - list_contexts(): See what data you've saved

4. **Subagent Delegation** (For isolated subtasks):
   - spawn_subagent(subtask, context?): Delegate independent tasks to subagents
   - Each subagent has its own execution context
   - Use for parallel or isolated work

🚀 HOW TO OPERATE:
1. **For Complex Tasks**: Use create_plan to break down into steps
2. **Navigate & Analyze** - Go to website, use analyze_website() ONCE
3. **Extract Data** - Use extract_smart_content() ONCE per page, save_context() if needed
4. **CREATE THE FILE IMMEDIATELY** - Don't re-extract, just create_excel/create_word/create_pdf
5. **Verify** - If you see "file created successfully", STOP - you're done!

🛠️ AVAILABLE TOOLS:
${toolDescriptions}

🎯 AUTONOMOUS WORKFLOW:
1. For complex tasks → Use create_plan first
2. Navigate to page → analyze_website() ONCE
3. Extract data → extract_smart_content() ONCE, save_context() if needed
4. Follow your plan systematically
5. Create documents IMMEDIATELY after extracting data
6. If file created successfully → STOP, you're done!

💡 BEST PRACTICES:
- **Efficiency**: Extract data ONCE per page, then create the file
- **Planning**: Use create_plan for tasks with 3+ distinct steps
- **Context**: Use save_context() for data you'll combine later
- **Documents**: Create the file as soon as you have the data
- **Stop Condition**: If "file created successfully" appears, STOP immediately
- **No Loops**: Don't re-extract or re-analyze the same page

📝 EXAMPLE WORKFLOWS:

**Simple Task (no planning needed):**
1. navigate(url) → analyze_website() → extract_smart_content()
2. create_excel(data) → STOP when you see "file created successfully"!

**Complex Task (use planning):**
1. create_plan(goal="Extract data from 3 websites", steps=[...])
2. Execute step 1 → save_context("site1_data", data)
3. Execute step 2 → save_context("site2_data", data)
4. Execute step 3 → save_context("site3_data", data)
5. load_context("site1_data") + load_context("site2_data") + load_context("site3_data")
6. create_excel(combined_data) → STOP when you see "file created successfully"!`;

    return basePrompt;
  }

  /**
   * Detect if agent is stuck in a severe loop
   * Improved to catch reflection loops and repeated extractions earlier
   */
  private detectLoop(recentActions: string[]): boolean {
    if (recentActions.length < 8) return false;

    // Check for repeating patterns of 4 actions (more sensitive)
    const last8 = recentActions.slice(-8);
    const pattern1 = last8.slice(0, 4).join(',');
    const pattern2 = last8.slice(4, 8).join(',');

    if (pattern1 === pattern2 && pattern1.length > 0) {
      console.warn('⚠️  Loop detected: repeating 4-action pattern:', pattern1);
      return true;
    }

    // Check if same action repeated 6+ times in last 10 (more sensitive)
    const actionCounts = new Map<string, number>();
    const last10 = recentActions.slice(-10);

    for (const action of last10) {
      actionCounts.set(action, (actionCounts.get(action) || 0) + 1);
    }

    for (const [action, count] of actionCounts.entries()) {
      // More sensitive - catch loops earlier
      if (count >= 6) {
        console.warn(`⚠️  Loop detected: "${action}" repeated ${count} times in last 10 actions`);
        return true;
      }
    }

    // Check for reflection loops (extract -> analyze -> extract pattern)
    const last6 = recentActions.slice(-6);
    const hasExtractLoop = last6.filter(a => 
      a.includes('extract') || a.includes('analyze')
    ).length >= 4;
    
    if (hasExtractLoop) {
      console.warn('⚠️  Reflection loop detected: too many extract/analyze calls');
      return true;
    }

    return false;
  }

  /**
   * Decide if agent should continue or end (with plan awareness)
   */
  private shouldContinue = (state: typeof AgentState.State): 'continue' | 'end' => {
    const { messages, toolCalls, recentActions, plan } = state;
    const lastMessage = messages[messages.length - 1] as AIMessage;

    // Check if a file was created successfully in the last message
    if (lastMessage) {
      const lastToolMessages = messages
        .slice()
        .reverse()
        .filter((msg: any) => msg.constructor.name === 'ToolMessage')
        .slice(0, 5);
      
      for (const toolMsg of lastToolMessages) {
        const content = String(toolMsg.content || '');
        if (content.includes('created successfully') || 
            content.includes('Excel file created') ||
            content.includes('Word document created') ||
            content.includes('PDF created')) {
          console.log('✅ File created successfully - stopping execution');
          return 'end';
        }
      }
    }

    // Max iterations check
    if (toolCalls >= RETRY_LIMITS.MAX_AGENT_ITERATIONS) {
      console.warn(`⚠️  Max iterations (${RETRY_LIMITS.MAX_AGENT_ITERATIONS}) reached - stopping`);
      return 'end';
    }

    // Check for severe loops (only stop if really stuck)
    if (this.detectLoop(recentActions || [])) {
      console.warn('🔄 Severe loop detected - ending task');
      return 'end';
    }

    // If LLM called tools, execute them
    if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
      return 'continue';
    }

    // If we have a plan, check if it's complete
    if (plan && this.isPlanComplete(plan)) {
      console.log('✅ Plan completed - all steps finished');
      return 'end';
    }

    // If we have a plan with pending steps, continue even if no tools called
    // The agent might need to think about the next step
    if (plan && plan.todos && plan.todos.length > 0) {
      const pendingSteps = plan.todos.filter(t => t.status === 'pending');
      if (pendingSteps.length > 0) {
        const currentStep = plan.todos[plan.currentStepIndex];
        if (currentStep && currentStep.status === 'pending') {
          console.log(`📋 Plan has ${pendingSteps.length} pending step(s) - continuing`);
          // Force agent to continue by adding a reminder message
          return 'continue';
        }
      }
    }

    // If no tools called and no plan, the agent has finished thinking and is done
    console.log('✅ Agent completed - no more tools to call');
    return 'end';
  };

  /**
   * Execute a single task using the autonomous agent
   */
  async executeSingle(userQuery: string): Promise<TaskResult> {
    try {
      console.log(`\n🎯 Executing autonomous task: "${userQuery}"\n`);

      // Generate new thread ID for this execution to ensure clean state
      const executionThreadId = `execution-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      const goal = userQuery;

      // Notify UI
      this.notifyProgress({
        agentId: 'main-agent',
        tabId: this.window.activeTab?.id || '',
        status: 'working',
        progress: 0,
        currentThought: `Starting autonomous task: ${goal}`,
      });

      // Execute with streaming
      let lastEvent: any = null;
      let stepCount = 0;
      let createdDocuments: Array<{ type: string; path: string; filename: string }> = [];
      let lastNotifiedPlan: TaskPlan | null = null;

      for await (const event of await this.app.stream(
        {
          messages: [new HumanMessage(userQuery)],
          goal,
          attempts: 0,
          failedActions: [],
          successIndicators: [],
          recentActions: [],
        },
        {
          configurable: { thread_id: executionThreadId },
          streamMode: 'values',
        }
      )) {
        lastEvent = event;
        stepCount++;

        // Only notify UI about important events (plan updates, completions, milestones)
        let shouldNotify = false;
        let notificationMessage = '';

        // Log intermediate steps with detailed tool tracking (console only, not UI)
        if (event.messages) {
          const lastMsg = event.messages[event.messages.length - 1];

          // Log tool calls (agent deciding what to do)
          if (lastMsg instanceof AIMessage && lastMsg.tool_calls) {
            const toolNames = lastMsg.tool_calls.map((tc: any) => tc.name);
            console.log(`\n🔧 Tool calls (${stepCount}):`, toolNames.join(', '));

            // Detailed logging for each tool call
            lastMsg.tool_calls.forEach((tc: any) => {
              console.log(`   📝 ${tc.name}:`, JSON.stringify(tc.args).substring(0, 200));
            });
          }

          // Log tool responses (results of tool execution)
          if (lastMsg instanceof ToolMessage) {
            const toolMsg = lastMsg;
            const toolName = toolMsg.name || 'unknown';
            const content = String(toolMsg.content);
            console.log(`\n✅ Tool response (${stepCount}) from ${toolName}:`, content.substring(0, 300));

            // Notify user about plan creation
            if (toolName === 'create_plan') {
              try {
                const response = JSON.parse(content);
                if (response.success && response.plan) {
                  shouldNotify = true;
                  notificationMessage = `📋 Plan created: ${response.plan.todos.length} steps`;
                }
              } catch (e) {
                // Ignore parse errors
              }
            }

            // Notify user about plan step updates
            if (toolName === 'update_plan_step') {
              try {
                const response = JSON.parse(content);
                if (response.success) {
                  shouldNotify = true;
                  notificationMessage = `✅ Completed: ${response.stepId}`;
                }
              } catch (e) {
                // Ignore parse errors
              }
            }

            // Track document creation with file path
            if (['create_excel', 'create_word', 'create_pdf'].includes(toolName)) {
              if (content.includes('created successfully')) {
                console.log(`   🎉 DOCUMENT CREATED SUCCESSFULLY!`);
                shouldNotify = true;

                // Extract file path from response
                const pathMatch = content.match(/Location: (.+?)(?:\n|$)/);
                if (pathMatch) {
                  const filePath = pathMatch[1].trim();
                  const filename = filePath.split('/').pop() || 'unknown';
                  const docType = toolName.replace('create_', '').toUpperCase();

                  createdDocuments.push({
                    type: docType,
                    path: filePath,
                    filename: filename
                  });

                  notificationMessage = `📄 Created ${docType}: ${filename}`;
                  console.log(`   📄 Tracked: ${docType} file "${filename}"`);
                }
              }
            }
          }
        }

        // Check if plan has changed (new plan or progress update)
        if (event.plan && event.plan !== lastNotifiedPlan) {
          const plan = event.plan;

          // If plan was just created
          if (!lastNotifiedPlan && plan.todos && plan.todos.length > 0) {
            shouldNotify = true;
            notificationMessage = `📋 Plan created with ${plan.todos.length} steps`;
            lastNotifiedPlan = plan;
          }
          // If plan progress changed
          else if (lastNotifiedPlan) {
            const completedCount = plan.todos.filter((t: any) => t.status === 'completed').length;
            const lastCompletedCount = lastNotifiedPlan.todos.filter(t => t.status === 'completed').length;

            if (completedCount > lastCompletedCount) {
              shouldNotify = true;
              notificationMessage = `✅ Progress: ${completedCount}/${plan.todos.length} steps completed`;
              lastNotifiedPlan = plan;
            }
          }
        }

        // Only send UI notification for important events
        if (shouldNotify && notificationMessage) {
          const progress = Math.min((stepCount / RETRY_LIMITS.MAX_AGENT_ITERATIONS) * 100, 95);
          this.notifyProgress({
            agentId: 'main-agent',
            tabId: this.window.activeTab?.id || '',
            status: 'working',
            progress,
            currentThought: notificationMessage,
          });
        }
      }

      // Get final result
      const finalMessages = lastEvent?.messages || [];
      const lastMessage = finalMessages[finalMessages.length - 1];
      let output = lastMessage?.content || 'Task completed';

      // Check if any tool message indicates file creation
      const toolMessages = finalMessages.filter((msg: any) => msg.constructor.name === 'ToolMessage');
      const hasFileCreation = toolMessages.some((msg: any) => {
        const content = String(msg.content || '');
        return content.includes('created successfully') || 
               content.includes('Excel file created') ||
               content.includes('Word document created') ||
               content.includes('PDF created');
      });

      // Enhance output with document creation details
      if (createdDocuments.length > 0 || hasFileCreation) {
        const docSummary = createdDocuments.length > 0 
          ? createdDocuments.map(doc =>
              `📄 ${doc.type}: ${doc.filename}\n   📁 Location: ${doc.path}`
            ).join('\n\n')
          : 'File created successfully (see tool responses above)';

        output = `✅ Task completed successfully!\n\n${docSummary}`;
      }

      console.log(`\n✅ Task completed\n`);
      console.log(`📋 Final output: ${output}\n`);

      await this.cleanupCreatedTabs();

      // Determine success - check if output contains success indicators
      const outputLower = output.toString().toLowerCase();
      const success = outputLower.includes('excel file created') ||
                     outputLower.includes('word document created') ||
                     outputLower.includes('pdf created') ||
                     outputLower.includes('successfully') ||
                     !outputLower.includes('error');

      // Notify completion
      this.notifyProgress({
        agentId: 'main-agent',
        tabId: this.window.activeTab?.id || '',
        status: success ? 'completed' : 'error',
        progress: 100,
        currentThought: success ? 'Task completed successfully' : 'Task completed with issues',
      });

      return {
        success,
        output: typeof output === 'string' ? output : JSON.stringify(output),
        data: {
          ...lastEvent,
          goal,
          attempts: lastEvent?.attempts || stepCount,
        },
      };
    } catch (error) {
      console.error('❌ Agent execution failed:', error);

      this.notifyProgress({
        agentId: 'main-agent',
        tabId: this.window.activeTab?.id || '',
        status: 'error',
        progress: 0,
        currentThought: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });

      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      // Always cleanup tabs, even on error
      await this.cleanupCreatedTabs();
    }
  }

  /**
   * Cleanup: Close all tabs created during execution and return to original tab
   */
  private async cleanupCreatedTabs(): Promise<void> {
    if (this.createdTabs.length === 0 && this.window.activeTab?.id === this.originalActiveTab?.id) {
      return; // Nothing to clean up
    }

    const tabsToClose = this.createdTabs.filter(tab => {
      // Only close tabs that still exist and aren't the original tab
      const tabStillExists = this.window.allTabs.some(t => t.id === tab.id);
      return tabStillExists && tab.id !== this.originalActiveTab?.id;
    });

    if (tabsToClose.length === 0) {
      this.createdTabs = [];
      return;
    }

    console.log(`\n🧹 Cleaning up ${tabsToClose.length} created tab(s)...`);

    // Close all created tabs
    for (const tab of tabsToClose) {
      try {
        // Small delay between closes
        await new Promise(resolve => setTimeout(resolve, 200));
        await this.window.closeTab(tab.id);
        console.log(`🗑️  Closed tab ${tab.id}`);
      } catch (error) {
        console.warn(`⚠️  Failed to close tab ${tab.id}:`, error);
      }
    }

    // Switch back to original active tab if it still exists
    if (this.originalActiveTab) {
      const originalTabStillExists = this.window.allTabs.some(t => t.id === this.originalActiveTab!.id);
      if (originalTabStillExists && this.window.activeTab?.id !== this.originalActiveTab.id) {
        try {
          await this.window.switchActiveTab(this.originalActiveTab.id);
          console.log(`↩️  Returned to original tab ${this.originalActiveTab.id}`);
        } catch (error) {
          console.warn(`⚠️  Failed to switch back to original tab:`, error);
        }
      }
    }

    this.createdTabs = [];
    console.log(`✅ Cleanup complete - only main tab remains\n`);
  }

  /**
   * Analyze if task can benefit from parallelization
   */
  async shouldParallelize(userQuery: string): Promise<boolean> {
    try {
      const analysisLLM = new ChatOpenAI({
        model: 'gpt-4o-mini',
        temperature: 0,
      });

      const result = await analysisLLM.invoke([
        {
          role: 'system',
          content: `Analyze if this task can benefit from parallel execution in multiple browser tabs.

Examples of tasks that CAN be parallelized:
- "Analyze 10 different stocks" → Can open multiple tabs, one per stock
- "Compare prices on 5 websites" → Can open all websites simultaneously
- "Research multiple topics" → Can research each topic in parallel

Examples of tasks that CANNOT be parallelized:
- "Login and checkout on Amazon" → Sequential steps
- "Fill out a form" → Single page operation
- "Search and click result" → Linear workflow

Respond with ONLY "YES" or "NO".`,
        },
        { role: 'user', content: userQuery },
      ]);

      const response = (result.content as string).trim().toUpperCase();
      return response.includes('YES');
    } catch (error) {
      console.error('Parallelization analysis failed:', error);
      return false;
    }
  }

  /**
   * Get agent state (for debugging)
   */
  async getState() {
    return await this.app.getState({
      configurable: { thread_id: this.threadId },
    });
  }

  /**
   * Get conversation history
   */
  async getHistory(): Promise<BaseMessage[]> {
    const state = await this.getState();
    return state?.values?.messages || [];
  }

  /**
   * Clear agent memory
   */
  async clearMemory(): Promise<void> {
    // Create new thread ID to reset memory
    this.threadId = `session-${Date.now()}`;
    console.log('✅ Agent memory cleared, new session started');
  }

  /**
   * Notify UI of progress
   */
  private notifyProgress(progress: any): void {
    try {
      this.window.sidebar.view.webContents.send('agent-progress', progress);
    } catch (error) {
      // Silently fail if UI notification fails
    }
  }
}
