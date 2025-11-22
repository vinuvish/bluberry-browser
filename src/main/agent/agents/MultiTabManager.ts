/**
 * Multi-Tab Manager - Handles parallel agent execution
 * Orchestrates multiple agents working simultaneously in different tabs
 */

import { ChatOpenAI } from '@langchain/openai';
import { AgentOrchestrator } from './AgentOrchestrator';
import { createDocumentTools } from '../tools/DocumentTools';
import type { Window } from '../../Window';
import type { SubTask, TaskResult, SubTaskResult, ExecutionPlan } from '../types';

export class MultiTabManager {
  private activeWorkers: Map<string, AgentOrchestrator> = new Map();

  constructor(
    private window: Window,
    private mainOrchestrator: AgentOrchestrator
  ) { }

  /**
   * Execute task with parallel agents across multiple tabs
   */
  async executeParallel(userQuery: string): Promise<TaskResult> {
    try {
      console.log('🚀 Starting parallel execution for:', userQuery);

      // Store the original active tab to return to it later
      const originalActiveTab = this.window.activeTab;
      const createdTabs: any[] = [];

      // Step 1: Create execution plan with sub-tasks
      const plan = await this.createExecutionPlan(userQuery);

      if (!plan.parallelTasks || plan.parallelTasks.length === 0) {
        console.log('No parallel tasks identified, falling back to sequential');
        return await this.mainOrchestrator.executeSingle(userQuery);
      }

      // Notify UI of the plan
      this.notifyPlan(plan);

      console.log(`📋 Plan: ${plan.parallelTasks.length} parallel tasks`);

      // Step 2: Execute all sub-tasks in parallel
      const results = await this.executeSubTasksInParallel(plan.parallelTasks, createdTabs);

      // Step 3: Synthesize results into final answer
      const finalResult = await this.synthesizeResults(userQuery, results);

      // Step 4: Close all created tabs and return to original tab
      await this.cleanupTabs(createdTabs, originalActiveTab);

      console.log('✅ Parallel execution completed');

      return {
        success: true,
        output: finalResult,
        data: { subResults: results }
      };
    } catch (error) {
      console.error('❌ Parallel execution failed:', error);
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Create execution plan by asking LLM to break task into sub-tasks
   */
  private async createExecutionPlan(userQuery: string): Promise<ExecutionPlan> {
    const llm = new ChatOpenAI({
      model: 'gpt-4o',
      temperature: 0
    });

    const prompt = `You are a task planning expert. Break down this task into parallel sub-tasks that can be executed simultaneously in different browser tabs.

Task: "${userQuery}"

Analyze if this task can be parallelized. If yes, create 2-5 sub-tasks that can run independently.

Return a JSON object in this exact format:
{
  "canParallelize": true/false,
  "parallelTasks": [
    {
      "id": "task-1",
      "goal": "Specific goal for this sub-task",
      "description": "Brief description",
      "initialUrl": "Starting URL (optional)"
    }
  ],
  "taskName": "Brief task name",
  "estimatedTime": "2-3 minutes"
}

If the task cannot be parallelized, set canParallelize to false and parallelTasks to empty array.`;

    const result = await llm.invoke([
      { role: 'system', content: 'You are a task planning expert. Return valid JSON only.' },
      { role: 'user', content: prompt }
    ]);

    try {
      // Extract JSON from response
      const content = result.content as string;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { canParallelize: false };
      }

      const plan = JSON.parse(jsonMatch[0]) as ExecutionPlan;
      return plan;
    } catch (error) {
      console.error('Failed to parse execution plan:', error);
      return { canParallelize: false };
    }
  }

  /**
   * Execute all sub-tasks in parallel, each in its own tab
   * First task uses current tab, rest create new tabs
   */
  private async executeSubTasksInParallel(subTasks: SubTask[], createdTabs: any[]): Promise<SubTaskResult[]> {
    const workerPromises = subTasks.map(async (subTask, index) => {
      let createdTab: any = null;

      try {
        // First task uses current/active tab, rest create new tabs
        if (index === 0) {
          createdTab = this.window.activeTab;
          console.log(`🔹 Starting worker in CURRENT TAB for: ${subTask.goal} (Tab: ${createdTab?.id})`);
        } else {
          createdTab = await this.window.createTab(subTask.initialUrl || 'about:blank');
          createdTabs.push(createdTab); // Track created tabs
          console.log(`🔹 Starting worker in NEW TAB for: ${subTask.goal} (Tab: ${createdTab.id})`);

          // Wait a bit for the tab to be fully initialized before attaching Puppeteer
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Create dedicated orchestrator for this specific tab
        const worker = new AgentOrchestrator(this.window, createdTab);
        this.activeWorkers.set(subTask.id, worker);

        // Notify UI
        this.notifyProgress({
          agentId: subTask.id,
          tabId: createdTab.id,
          status: 'working',
          progress: 0,
          currentThought: `Starting: ${subTask.description}`,
          currentUrl: createdTab.url
        });

        // Execute sub-task with timeout
        const WORKER_TIMEOUT = 300000; // 5 minutes
        const timeoutPromise = new Promise<TaskResult>((_, reject) => {
          setTimeout(() => reject(new Error(`Worker timed out after ${WORKER_TIMEOUT}ms`)), WORKER_TIMEOUT);
        });

        const result = await Promise.race([
          worker.executeSingle(subTask.goal),
          timeoutPromise
        ]);

        // Notify completion
        this.notifyProgress({
          agentId: subTask.id,
          tabId: createdTab.id,
          status: 'completed',
          progress: 100,
          currentThought: 'Sub-task completed',
          currentUrl: createdTab.url
        });

        console.log(`✅ Worker ${subTask.id} completed successfully`);

        return {
          subTaskId: subTask.id,
          data: result.output,
          success: result.success,
          error: result.error
        };
      } catch (error) {
        console.error(`Worker ${subTask.id} failed:`, error);

        this.notifyProgress({
          agentId: subTask.id,
          tabId: createdTab?.id || '',
          status: 'error',
          progress: 0,
          currentThought: `Error: ${error instanceof Error ? error.message : 'Unknown'}`
        });

        return {
          subTaskId: subTask.id,
          data: null,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      } finally {
        // Cleanup: Remove worker (but don't close tabs here - we'll close them all at once)
        this.activeWorkers.delete(subTask.id);
      }
    });

    // Wait for all workers to complete
    return await Promise.all(workerPromises);
  }

  /**
   * Synthesize results from all parallel agents into final answer
   * If the task involves creating an Excel file, actually create it here
   */
  private async synthesizeResults(originalQuery: string, results: SubTaskResult[]): Promise<string> {
    const successfulResults = results.filter(r => r.success);
    const failedResults = results.filter(r => !r.success);

    // Check if the original query asks for Excel/Word/PDF creation
    const needsExcel = /excel|spreadsheet|csv/i.test(originalQuery);
    const needsWord = /word|docx|doc/i.test(originalQuery);
    const needsPdf = /pdf/i.test(originalQuery);
    const needsFileCreation = needsExcel || needsWord || needsPdf;

    if (needsFileCreation && successfulResults.length > 0) {
      // Try to extract structured data from results and create the file
      try {
        const llm = new ChatOpenAI({
          model: 'gpt-4o',
          temperature: 0
        });

        const documentTools = createDocumentTools();
        let toolName = '';
        let extractionPrompt = '';
        let systemPrompt = '';

        if (needsExcel) {
          toolName = 'create_excel';
          systemPrompt = 'You extract structured data from text. Return ONLY valid JSON array of objects, no other text.';
          extractionPrompt = `Original task: "${originalQuery}"

Completed sub-tasks results:
${successfulResults.map((r, i) => `Sub-task ${i + 1} (${r.subTaskId}):\n${r.data}`).join('\n\n')}

Extract all the data from the above results and format it as a JSON array of objects suitable for creating an Excel file.
Each object should represent one row with consistent column names.
Return ONLY valid JSON array, no other text.`;
        } else {
          // PDF or Word - needs sections structure
          toolName = needsPdf ? 'create_pdf' : 'create_word';
          systemPrompt = 'You extract structured content for a document. Return ONLY valid JSON object matching the schema, no other text.';
          extractionPrompt = `Original task: "${originalQuery}"

Completed sub-tasks results:
${successfulResults.map((r, i) => `Sub-task ${i + 1} (${r.subTaskId}):\n${r.data}`).join('\n\n')}

Extract the content and format it for a ${needsPdf ? 'PDF' : 'Word'} document.
Return a JSON object with this exact structure:
{
  "title": "Document Title",
  "sections": [
    {
      "heading": "Section Heading",
      "paragraphs": ["Paragraph 1", "Paragraph 2"],
      "table": [{"col1": "val1", "col2": "val2"}] // Optional table data
    }
  ]
}
Return ONLY valid JSON, no other text.`;
        }

        const extractionResult = await llm.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: extractionPrompt }
        ]);

        // Parse the extracted data
        const content = extractionResult.content as string;
        const jsonMatch = content.match(/\{[\s\S]*\}|\[[\s\S]*\]/);

        if (jsonMatch) {
          const data = JSON.parse(jsonMatch[0]);
          const tool = documentTools.find((t: any) => t.name === toolName);

          if (tool) {
            const filename = `report_${Date.now()}.${needsExcel ? 'xlsx' : needsPdf ? 'pdf' : 'docx'}`;
            let toolArgs: any = { filename };

            if (needsExcel) {
              toolArgs.data = data;
              toolArgs.sheetName = 'Data';
            } else {
              toolArgs.title = data.title;
              toolArgs.sections = data.sections;
            }

            // Cast to any to avoid TS error
            const result = await (tool as any).func(toolArgs);

            if (result.includes('created successfully')) {
              return `✅ Task completed successfully!\n\n${result}\n\nData from ${successfulResults.length} sub-task(s) combined into one document.`;
            }
          }
        }
      } catch (error) {
        console.warn('Failed to create file from synthesized results:', error);
        // Fall through to text synthesis
      }
    }

    // Fallback to text synthesis
    const llm = new ChatOpenAI({
      model: 'gpt-4o',
      temperature: 0
    });

    let synthesisPrompt = `Original task: "${originalQuery}"\n\n`;
    synthesisPrompt += `Completed sub-tasks (${successfulResults.length}/${results.length}):\n\n`;

    successfulResults.forEach((result, index) => {
      synthesisPrompt += `Sub-task ${index + 1}:\n${result.data}\n\n`;
    });

    if (failedResults.length > 0) {
      synthesisPrompt += `\nFailed sub-tasks: ${failedResults.length}\n`;
      failedResults.forEach(r => {
        synthesisPrompt += `- ${r.subTaskId}: ${r.error}\n`;
      });
    }

    synthesisPrompt += `\nBased on the results above, provide a comprehensive answer to the original task.`;

    const result = await llm.invoke([
      {
        role: 'system',
        content: 'You are synthesizing results from multiple parallel tasks. Combine them into a coherent, comprehensive response.'
      },
      { role: 'user', content: synthesisPrompt }
    ]);

    return result.content as string;
  }

  /**
   * Notify UI of execution plan
   */
  private notifyPlan(plan: ExecutionPlan): void {
    try {
      this.window.sidebar.view.webContents.send('agent-plan-update', {
        ...plan,
        overallProgress: 0
      });
    } catch (error) {
      // Silently fail
    }
  }

  /**
   * Notify UI of worker progress
   */
  private notifyProgress(progress: any): void {
    try {
      this.window.sidebar.view.webContents.send('agent-progress', progress);
    } catch (error) {
      // Silently fail
    }
  }

  /**
   * Cleanup: Close all created tabs and return to original active tab
   */
  private async cleanupTabs(createdTabs: any[], originalActiveTab: any): Promise<void> {
    console.log(`\n🧹 Cleaning up ${createdTabs.length} created tab(s)...`);

    // Close all created tabs
    for (const tab of createdTabs) {
      try {
        // Small delay between closes to avoid race conditions
        await new Promise(resolve => setTimeout(resolve, 200));
        await this.window.closeTab(tab.id);
        console.log(`🗑️  Closed tab ${tab.id}`);
      } catch (error) {
        console.warn(`⚠️  Failed to close tab ${tab.id}:`, error);
      }
    }

    // Switch back to original active tab
    if (originalActiveTab && this.window.activeTab?.id !== originalActiveTab.id) {
      try {
        await this.window.switchActiveTab(originalActiveTab.id);
        console.log(`↩️  Returned to original tab ${originalActiveTab.id}`);
      } catch (error) {
        console.warn(`⚠️  Failed to switch back to original tab:`, error);
      }
    }

    console.log(`✅ Cleanup complete - only main tab remains\n`);
  }

  /**
   * Stop all active workers
   */
  async stopAll(): Promise<void> {
    for (const worker of this.activeWorkers.values()) {
      await worker.clearMemory();
    }
    this.activeWorkers.clear();
  }
}
