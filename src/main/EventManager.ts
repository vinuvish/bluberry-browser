import { ipcMain, WebContents } from "electron";
import type { Window } from "./Window";
import type { TaskScheduler, ScheduledTask, TaskSchedule } from "./scheduler/TaskScheduler";
import { AgentSystem } from "./agent";

// Global set to track all registered handlers across all instances
const globalRegisteredHandlers = new Set<string>();

export class EventManager {
  private mainWindow: Window;
  private agentSystem: AgentSystem | null = null;
  private taskScheduler: TaskScheduler | undefined;
  private registeredHandlers: Set<string> = new Set();

  constructor(mainWindow: Window, taskScheduler?: TaskScheduler) {
    this.mainWindow = mainWindow;
    this.taskScheduler = taskScheduler;
    this.setupEventHandlers();
  }

  /**
   * Safely register IPC handler - removes existing handler first to prevent duplicates
   */
  private safeHandle(channel: string, handler: (event: any, ...args: any[]) => any): void {
    // Remove existing handler if present (check globally, not just this instance)
    if (globalRegisteredHandlers.has(channel)) {
      try {
        ipcMain.removeHandler(channel);
        globalRegisteredHandlers.delete(channel);
      } catch (error) {
        // Handler might not exist anymore, that's okay
        console.warn(`Warning: Could not remove existing handler for ${channel}:`, error);
      }
    }

    // Register new handler
    try {
      ipcMain.handle(channel, handler);
      this.registeredHandlers.add(channel);
      globalRegisteredHandlers.add(channel);
    } catch (error) {
      console.error(`Failed to register IPC handler for ${channel}:`, error);
      throw error;
    }
  }

  /**
   * Cleanup all registered handlers and resources
   */
  public cleanup(): void {
    console.log("🧹 Cleaning up EventManager");

    // Remove all IPC handlers
    this.registeredHandlers.forEach(channel => {
      try {
        ipcMain.removeHandler(channel);
        globalRegisteredHandlers.delete(channel);
      } catch (error) {
        // Handler might not exist, that's okay
      }
    });
    this.registeredHandlers.clear();

    // Stop agent system
    if (this.agentSystem) {
      this.agentSystem.stop();
    }

    // Remove all listeners
    ipcMain.removeAllListeners();
  }

  private setupEventHandlers(): void {
    // Tab management events
    this.handleTabEvents();

    // Sidebar events
    this.handleSidebarEvents();

    // Page content events
    this.handlePageContentEvents();

    // Dark mode events
    this.handleDarkModeEvents();

    // Debug events
    this.handleDebugEvents();

    // Agent events
    this.handleAgentEvents();

    // Task scheduler events
    this.handleSchedulerEvents();
  }

  private handleTabEvents(): void {
    // Create new tab
    this.safeHandle("create-tab", (_, url?: string) => {
      const newTab = this.mainWindow.createTab(url);
      return { id: newTab.id, title: newTab.title, url: newTab.url };
    });

    // Close tab
    this.safeHandle("close-tab", (_, id: string) => {
      this.mainWindow.closeTab(id);
    });

    // Switch tab
    this.safeHandle("switch-tab", (_, id: string) => {
      this.mainWindow.switchActiveTab(id);
    });

    // Get tabs
    this.safeHandle("get-tabs", () => {
      const activeTabId = this.mainWindow.activeTab?.id;
      return this.mainWindow.allTabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        isActive: activeTabId === tab.id,
      }));
    });

    // Navigation (for compatibility with existing code)
    this.safeHandle("navigate-to", (_, url: string) => {
      if (this.mainWindow.activeTab) {
        this.mainWindow.activeTab.loadURL(url);
      }
    });

    this.safeHandle("navigate-tab", async (_, tabId: string, url: string) => {
      const tab = this.mainWindow.getTab(tabId);
      if (tab) {
        await tab.loadURL(url);
        return true;
      }
      return false;
    });

    this.safeHandle("go-back", () => {
      if (this.mainWindow.activeTab) {
        this.mainWindow.activeTab.goBack();
      }
    });

    this.safeHandle("go-forward", () => {
      if (this.mainWindow.activeTab) {
        this.mainWindow.activeTab.goForward();
      }
    });

    this.safeHandle("reload", () => {
      if (this.mainWindow.activeTab) {
        this.mainWindow.activeTab.reload();
      }
    });

    // Tab-specific navigation handlers
    this.safeHandle("tab-go-back", (_, tabId: string) => {
      const tab = this.mainWindow.getTab(tabId);
      if (tab) {
        tab.goBack();
        return true;
      }
      return false;
    });

    this.safeHandle("tab-go-forward", (_, tabId: string) => {
      const tab = this.mainWindow.getTab(tabId);
      if (tab) {
        tab.goForward();
        return true;
      }
      return false;
    });

    this.safeHandle("tab-reload", (_, tabId: string) => {
      const tab = this.mainWindow.getTab(tabId);
      if (tab) {
        tab.reload();
        return true;
      }
      return false;
    });

    this.safeHandle("tab-screenshot", async (_, tabId: string) => {
      const tab = this.mainWindow.getTab(tabId);
      if (tab) {
        const image = await tab.screenshot();
        return image.toDataURL();
      }
      return null;
    });

    this.safeHandle("tab-run-js", async (_, tabId: string, code: string) => {
      const tab = this.mainWindow.getTab(tabId);
      if (tab) {
        return await tab.runJs(code);
      }
      return null;
    });

    // Tab info
    this.safeHandle("get-active-tab-info", () => {
      const activeTab = this.mainWindow.activeTab;
      if (activeTab) {
        return {
          id: activeTab.id,
          url: activeTab.url,
          title: activeTab.title,
          canGoBack: activeTab.webContents.canGoBack(),
          canGoForward: activeTab.webContents.canGoForward(),
        };
      }
      return null;
    });
  }

  private handleSidebarEvents(): void {
    // Toggle sidebar
    this.safeHandle("toggle-sidebar", () => {
      this.mainWindow.sidebar.toggle();
      this.mainWindow.updateAllBounds();
      return true;
    });

    // Chat message
    this.safeHandle("sidebar-chat-message", async (_, request) => {
     // Extract the actual query (remove "agent" prefix)
     const query = request.message.trim();
        
     console.log('🤖 Routing to agent system:', query);
     
     // Add user message to chat
     this.mainWindow.sidebar.client.addMessage({
       role: 'user',
       content: request.message
     });
     
     // Lazy initialize agent system
     if (!this.agentSystem) {
       this.agentSystem = new AgentSystem(this.mainWindow);
     }
     
     // Execute via agent
     const result = await this.agentSystem.execute(query);
     
     // Send result back to chat
     this.mainWindow.sidebar.client.addMessage({
       role: 'assistant',
       content: result.output || result.error || 'Agent execution completed'
     });
     
     return;
      
    });

    // Clear chat
    this.safeHandle("sidebar-clear-chat", () => {
      this.mainWindow.sidebar.client.clearMessages();
      return true;
    });

    // Get messages
    this.safeHandle("sidebar-get-messages", () => {
      return this.mainWindow.sidebar.client.getMessages();
    });
  }

  private handlePageContentEvents(): void {
    // Get page content
    this.safeHandle("get-page-content", async () => {
      if (this.mainWindow.activeTab) {
        try {
          return await this.mainWindow.activeTab.getTabHtml();
        } catch (error) {
          console.error("Error getting page content:", error);
          return null;
        }
      }
      return null;
    });

    // Get page text
    this.safeHandle("get-page-text", async () => {
      if (this.mainWindow.activeTab) {
        try {
          return await this.mainWindow.activeTab.getTabText();
        } catch (error) {
          console.error("Error getting page text:", error);
          return null;
        }
      }
      return null;
    });

    // Get current URL
    this.safeHandle("get-current-url", () => {
      if (this.mainWindow.activeTab) {
        return this.mainWindow.activeTab.url;
      }
      return null;
    });
  }

  private handleDarkModeEvents(): void {
    // Dark mode broadcasting
    ipcMain.on("dark-mode-changed", (event, isDarkMode) => {
      this.broadcastDarkMode(event.sender, isDarkMode);
    });
  }

  private handleDebugEvents(): void {
    // Ping test
    ipcMain.on("ping", () => console.log("pong"));
  }

  private handleAgentEvents(): void {
    // Execute agent task
    this.safeHandle("agent-execute", async (_, userQuery: string) => {
      try {
        // Lazy initialize agent system
        if (!this.agentSystem) {
          this.agentSystem = new AgentSystem(this.mainWindow);
        }

        const result = await this.agentSystem.execute(userQuery);
        return result;
      } catch (error) {
        console.error("Agent execution error:", error);
        return {
          success: false,
          output: "",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    });

    // Stop agent
    this.safeHandle("agent-stop", async () => {
      if (this.agentSystem) {
        await this.agentSystem.stop();
        return true;
      }
      return false;
    });

    // Reset agent
    this.safeHandle("agent-reset", async () => {
      if (this.agentSystem) {
        await this.agentSystem.reset();
        return true;
      }
      return false;
    });
  }

  private broadcastDarkMode(sender: WebContents, isDarkMode: boolean): void {
    // Send to topbar
    if (this.mainWindow.topBar.view.webContents !== sender) {
      this.mainWindow.topBar.view.webContents.send(
        "dark-mode-updated",
        isDarkMode
      );
    }

    // Send to sidebar
    if (this.mainWindow.sidebar.view.webContents !== sender) {
      this.mainWindow.sidebar.view.webContents.send(
        "dark-mode-updated",
        isDarkMode
      );
    }

    // Send to all tabs
    this.mainWindow.allTabs.forEach((tab) => {
      if (tab.webContents !== sender) {
        tab.webContents.send("dark-mode-updated", isDarkMode);
      }
    });
  }

  private handleSchedulerEvents(): void {
    if (!this.taskScheduler) {
      console.log('Task scheduler not available, skipping scheduler event handlers');
      return;
    }

    const scheduler = this.taskScheduler;

    // Get all scheduled tasks
    this.safeHandle('scheduler:get-all-tasks', async () => {
      return scheduler.getAllTasks();
    });

    // Get task by ID
    this.safeHandle('scheduler:get-task', async (_, taskId: string) => {
      return scheduler.getTask(taskId);
    });

    // Create new scheduled task
    this.safeHandle('scheduler:create-task', async (_, taskData: {
      name: string;
      description?: string;
      prompt: string;
      schedule: TaskSchedule;
      maxRuns?: number;
    }) => {
      return await scheduler.createTask(taskData);
    });

    // Update task
    this.safeHandle('scheduler:update-task', async (_, taskId: string, updates: Partial<ScheduledTask>) => {
      return await scheduler.updateTask(taskId, updates);
    });

    // Pause task
    this.safeHandle('scheduler:pause-task', async (_, taskId: string) => {
      return await scheduler.pauseTask(taskId);
    });

    // Resume task
    this.safeHandle('scheduler:resume-task', async (_, taskId: string) => {
      return await scheduler.resumeTask(taskId);
    });

    // Cancel (delete) task
    this.safeHandle('scheduler:cancel-task', async (_, taskId: string) => {
      return await scheduler.cancelTask(taskId);
    });

    // Execute task immediately
    this.safeHandle('scheduler:execute-now', async (_, taskId: string) => {
      await scheduler.executeTaskNow(taskId);
      return true;
    });

    // Listen to scheduler events and forward to renderer
    scheduler.on('task-created', (task) => {
      this.mainWindow.allTabs.forEach(tab => {
        tab.webContents.send('scheduler:task-created', task);
      });
    });

    scheduler.on('task-updated', (task) => {
      this.mainWindow.allTabs.forEach(tab => {
        tab.webContents.send('scheduler:task-updated', task);
      });
    });

    scheduler.on('task-started', (task) => {
      this.mainWindow.allTabs.forEach(tab => {
        tab.webContents.send('scheduler:task-started', task);
      });
    });

    scheduler.on('task-completed', (task) => {
      this.mainWindow.allTabs.forEach(tab => {
        tab.webContents.send('scheduler:task-completed', task);
      });
    });

    scheduler.on('task-failed', (task, error) => {
      this.mainWindow.allTabs.forEach(tab => {
        tab.webContents.send('scheduler:task-failed', { task, error });
      });
    });

    scheduler.on('task-paused', (task) => {
      this.mainWindow.allTabs.forEach(tab => {
        tab.webContents.send('scheduler:task-paused', task);
      });
    });

    scheduler.on('task-resumed', (task) => {
      this.mainWindow.allTabs.forEach(tab => {
        tab.webContents.send('scheduler:task-resumed', task);
      });
    });

    console.log('✅ Task scheduler IPC handlers registered');
  }
}
