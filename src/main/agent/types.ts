/**
 * Shared types for the agent system
 */

export interface SubTask {
  id: string;
  goal: string;
  description: string;
  initialUrl?: string;
  expectedOutputs?: string[];
}

export interface AgentProgress {
  agentId: string;
  tabId: string;
  status: 'idle' | 'working' | 'completed' | 'error';
  progress: number;
  currentThought?: string;
  currentAction?: string;
  currentUrl?: string;
}

/**
 * Execution plan for parallel multi-tab execution
 */
export interface ExecutionPlan {
  canParallelize: boolean;
  parallelTasks?: SubTask[];
  estimatedTime?: string;
  taskName?: string;
  overallProgress?: number;
}

export interface TaskResult {
  success: boolean;
  output: string;
  data?: any;
  error?: string;
}

export interface SubTaskResult {
  subTaskId: string;
  data: any;
  success: boolean;
  error?: string;
}

/**
 * Plan-related types for DeepAgents-style orchestration
 */
export interface TodoItem {
  id: string;
  description: string;
  status: 'pending' | 'completed' | 'failed' | 'skipped';
  dependencies?: string[];
  result?: any;
  error?: string;
}

/**
 * Task planning for agent orchestration (DeepAgents-style)
 */
export interface TaskPlan {
  goal: string;
  todos: TodoItem[];
  currentStepIndex: number;
  createdAt: number;
  completedAt?: number;
}

/**
 * Subagent delegation types
 */
export interface SubagentTask {
  id: string;
  subtask: string;
  context?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: TaskResult;
  error?: string;
  duration?: number;
}

/**
 * Context file types for persistent storage
 */
export interface ContextFile {
  key: string;
  path: string;
  timestamp: number;
  size: number;
  description?: string;
}
