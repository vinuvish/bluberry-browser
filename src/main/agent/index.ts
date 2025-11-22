/**
 * Agent System - Main Entry Point
 * Autonomous browser agent with ReAct reasoning and parallel execution
 */

import { AgentOrchestrator } from './agents/AgentOrchestrator';
import { MultiTabManager } from './agents/MultiTabManager';
import type { Window } from '../Window';
import type { TaskResult } from './types';

export class AgentSystem {
  private orchestrator: AgentOrchestrator;
  private multiTab: MultiTabManager;

  constructor(window: Window) {
    this.orchestrator = new AgentOrchestrator(window);
    this.multiTab = new MultiTabManager(window, this.orchestrator as any);
  }

  /**
   * Main entry point for agent execution
   * Automatically decides between single-tab or multi-tab execution
   */
  async execute(userQuery: string): Promise<TaskResult> {
    try {
      console.log('\n' + '='.repeat(80));
      console.log('🤖 AGENT SYSTEM EXECUTING');
      console.log('Query:', userQuery);
      console.log('='.repeat(80) + '\n');

      // Analyze if task benefits from parallelization
      const shouldParallelize = await this.orchestrator.shouldParallelize(userQuery);

      if (shouldParallelize) {
        console.log('📊 Task identified as parallelizable - using multi-tab execution\n');
        return await this.multiTab.executeParallel(userQuery);
      } else {
        console.log('📝 Task identified as sequential - using single-tab execution\n');
        return await this.orchestrator.executeSingle(userQuery);
      }
    } catch (error) {
      console.error('❌ Agent system error:', error);
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Stop all running agents
   */
  async stop(): Promise<void> {
    await this.multiTab.stopAll();
    await this.orchestrator.clearMemory();
  }

  /**
   * Clear agent memory and state
   */
  async reset(): Promise<void> {
    await this.stop();
    console.log('🔄 Agent system reset');
  }
}

// Export types
export * from './types';
