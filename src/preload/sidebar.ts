import { contextBridge } from "electron";
import { electronAPI } from "@electron-toolkit/preload";

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

// Sidebar specific APIs
const sidebarAPI = {
  // Chat functionality
  sendChatMessage: (request: Partial<ChatRequest>) =>
    electronAPI.ipcRenderer.invoke("sidebar-chat-message", request),

  // Agent functionality
  executeAgent: (query: string) =>
    electronAPI.ipcRenderer.invoke("agent-execute", query),

  stopAgent: () => electronAPI.ipcRenderer.invoke("agent-stop"),

  resetAgent: () => electronAPI.ipcRenderer.invoke("agent-reset"),

  onAgentProgress: (callback: (progress: any) => void) => {
    electronAPI.ipcRenderer.on("agent-progress", (_, data) => callback(data));
  },

  onAgentPlanUpdate: (callback: (plan: any) => void) => {
    electronAPI.ipcRenderer.on("agent-plan-update", (_, data) => callback(data));
  },

  removeAgentProgressListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("agent-progress");
  },

  removeAgentPlanListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("agent-plan-update");
  },

  clearChat: () => electronAPI.ipcRenderer.invoke("sidebar-clear-chat"),

  getMessages: () => electronAPI.ipcRenderer.invoke("sidebar-get-messages"),

  onChatResponse: (callback: (data: ChatResponse) => void) => {
    electronAPI.ipcRenderer.on("chat-response", (_, data) => callback(data));
  },

  onMessagesUpdated: (callback: (messages: any[]) => void) => {
    electronAPI.ipcRenderer.on("chat-messages-updated", (_, messages) =>
      callback(messages)
    );
  },

  removeChatResponseListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("chat-response");
  },

  removeMessagesUpdatedListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("chat-messages-updated");
  },

  // Page content access
  getPageContent: () => electronAPI.ipcRenderer.invoke("get-page-content"),
  getPageText: () => electronAPI.ipcRenderer.invoke("get-page-text"),
  getCurrentUrl: () => electronAPI.ipcRenderer.invoke("get-current-url"),

  // Tab information
  getActiveTabInfo: () => electronAPI.ipcRenderer.invoke("get-active-tab-info"),

  // Task Scheduler functionality
  scheduler: {
    getAllTasks: () => electronAPI.ipcRenderer.invoke("scheduler:get-all-tasks"),

    getTask: (taskId: string) =>
      electronAPI.ipcRenderer.invoke("scheduler:get-task", taskId),

    createTask: (taskData: any) =>
      electronAPI.ipcRenderer.invoke("scheduler:create-task", taskData),

    updateTask: (taskId: string, updates: any) =>
      electronAPI.ipcRenderer.invoke("scheduler:update-task", taskId, updates),

    pauseTask: (taskId: string) =>
      electronAPI.ipcRenderer.invoke("scheduler:pause-task", taskId),

    resumeTask: (taskId: string) =>
      electronAPI.ipcRenderer.invoke("scheduler:resume-task", taskId),

    cancelTask: (taskId: string) =>
      electronAPI.ipcRenderer.invoke("scheduler:cancel-task", taskId),

    executeNow: (taskId: string) =>
      electronAPI.ipcRenderer.invoke("scheduler:execute-now", taskId),

    // Event listeners
    onTaskCreated: (callback: (task: any) => void) => {
      electronAPI.ipcRenderer.on("scheduler:task-created", (_, task) => callback(task));
    },

    onTaskUpdated: (callback: (task: any) => void) => {
      electronAPI.ipcRenderer.on("scheduler:task-updated", (_, task) => callback(task));
    },

    onTaskStarted: (callback: (task: any) => void) => {
      electronAPI.ipcRenderer.on("scheduler:task-started", (_, task) => callback(task));
    },

    onTaskCompleted: (callback: (task: any) => void) => {
      electronAPI.ipcRenderer.on("scheduler:task-completed", (_, task) => callback(task));
    },

    onTaskFailed: (callback: (data: any) => void) => {
      electronAPI.ipcRenderer.on("scheduler:task-failed", (_, data) => callback(data));
    },

    onTaskPaused: (callback: (task: any) => void) => {
      electronAPI.ipcRenderer.on("scheduler:task-paused", (_, task) => callback(task));
    },

    onTaskResumed: (callback: (task: any) => void) => {
      electronAPI.ipcRenderer.on("scheduler:task-resumed", (_, task) => callback(task));
    }
  }
};

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("sidebarAPI", sidebarAPI);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI;
  // @ts-ignore (define in dts)
  window.sidebarAPI = sidebarAPI;
}
