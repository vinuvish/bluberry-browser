import { ElectronAPI } from "@electron-toolkit/preload";

interface ChatRequest {
  message: string;
  context: {
    url: string | null;
    content: string | null;
    text: string | null;
  };
  messageId: string;
}

interface ChatResponse {
  messageId: string;
  content: string;
  isComplete: boolean;
}

interface TabInfo {
  id: string;
  title: string;
  url: string;
  isActive: boolean;
}

type TaskSchedule =
  | { type: 'once'; executeAt: Date }
  | { type: 'delay'; delayMinutes: number }
  | { type: 'recurring'; interval: 'hourly' | 'daily' | 'weekly' | 'monthly' }
  | { type: 'cron'; expression: string };

type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';

interface ScheduledTask {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  schedule: TaskSchedule;
  status: TaskStatus;
  createdAt: Date;
  lastRun?: Date;
  nextRun?: Date;
  runCount: number;
  maxRuns?: number;
  enabled: boolean;
  result?: {
    success: boolean;
    output: string;
    error?: string;
    timestamp: Date;
  };
}

interface SidebarAPI {
  // Chat functionality
  sendChatMessage: (request: Partial<ChatRequest>) => Promise<void>;
  clearChat: () => Promise<boolean>;
  getMessages: () => Promise<any[]>;
  onChatResponse: (callback: (data: ChatResponse) => void) => void;
  onMessagesUpdated: (callback: (messages: any[]) => void) => void;
  removeChatResponseListener: () => void;
  removeMessagesUpdatedListener: () => void;

  // Agent functionality
  executeAgent: (query: string) => Promise<any>;
  stopAgent: () => Promise<boolean>;
  resetAgent: () => Promise<boolean>;
  onAgentProgress: (callback: (progress: any) => void) => void;
  onAgentPlanUpdate: (callback: (plan: any) => void) => void;
  removeAgentProgressListener: () => void;
  removeAgentPlanListener: () => void;

  // Page content access
  getPageContent: () => Promise<string | null>;
  getPageText: () => Promise<string | null>;
  getCurrentUrl: () => Promise<string | null>;

  // Tab information
  getActiveTabInfo: () => Promise<TabInfo | null>;

  // Task Scheduler functionality
  scheduler: {
    getAllTasks: () => Promise<ScheduledTask[]>;
    getTask: (taskId: string) => Promise<ScheduledTask | undefined>;
    createTask: (taskData: {
      name: string;
      description?: string;
      prompt: string;
      schedule: TaskSchedule;
      maxRuns?: number;
    }) => Promise<ScheduledTask>;
    updateTask: (taskId: string, updates: Partial<ScheduledTask>) => Promise<ScheduledTask | null>;
    pauseTask: (taskId: string) => Promise<boolean>;
    resumeTask: (taskId: string) => Promise<boolean>;
    cancelTask: (taskId: string) => Promise<boolean>;
    executeNow: (taskId: string) => Promise<boolean>;

    // Event listeners
    onTaskCreated: (callback: (task: ScheduledTask) => void) => void;
    onTaskUpdated: (callback: (task: ScheduledTask) => void) => void;
    onTaskStarted: (callback: (task: ScheduledTask) => void) => void;
    onTaskCompleted: (callback: (task: ScheduledTask) => void) => void;
    onTaskFailed: (callback: (data: { task: ScheduledTask; error: any }) => void) => void;
    onTaskPaused: (callback: (task: ScheduledTask) => void) => void;
    onTaskResumed: (callback: (task: ScheduledTask) => void) => void;
  };
}

declare global {
  interface Window {
    electron: ElectronAPI;
    sidebarAPI: SidebarAPI;
  }
}

