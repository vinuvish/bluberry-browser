import { app, BrowserWindow, Notification } from "electron";
import { electronApp } from "@electron-toolkit/utils";
import { Window } from "./Window";
import { AppMenu } from "./Menu";
import { EventManager } from "./EventManager";
import { PuppeteerManager } from "./PuppeteerManager";
import { TaskScheduler } from "./scheduler/TaskScheduler";
import { HeadlessBrowserManager } from "./scheduler/HeadlessBrowserManager";
import { HeadlessAgentExecutor } from "./scheduler/HeadlessAgentExecutor";
import pie from "puppeteer-in-electron";

let mainWindow: Window | null = null;
let eventManager: EventManager | null = null;
let menu: AppMenu | null = null;
let puppeteerManager: PuppeteerManager | null = null;
let taskScheduler: TaskScheduler | null = null;
let headlessBrowserManager: HeadlessBrowserManager | null = null;

const createWindow = (puppeteer?: PuppeteerManager, scheduler?: TaskScheduler): Window => {
  // Clean up existing eventManager if present to avoid duplicate handlers
  if (eventManager) {
    console.log('⚠️  Cleaning up existing EventManager before creating new one');
    eventManager.cleanup();
    eventManager = null;
  }

  const window = new Window(puppeteer, scheduler);
  menu = new AppMenu(window);
  eventManager = new EventManager(window, scheduler);
  console.log('✅ EventManager created and handlers registered');
  return window;
};

// Initialize puppeteer-in-electron BEFORE app is ready
// This MUST be called synchronously at module load time
pie.initialize(app);

// Handle unhandled promise rejections gracefully
process.on('unhandledRejection', (reason) => {
  const errorMsg = reason instanceof Error ? reason.message : String(reason);
  
  // Ignore navigation errors for blocked resources (ads, tracking, etc.)
  if (errorMsg.includes('ERR_BLOCKED_BY_RESPONSE') || 
      errorMsg.includes('ERR_CONNECTION_TIMED_OUT') ||
      errorMsg.includes('code: -27') ||
      errorMsg.includes('code: -106')) {
    // These are normal for blocked ads/tracking - silently ignore
    return;
  }
  
  // Log other unhandled rejections but don't crash
  console.warn('⚠️  Unhandled promise rejection:', errorMsg);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  const errorMsg = error.message;
  
  // Ignore navigation errors for blocked resources
  if (errorMsg.includes('ERR_BLOCKED_BY_RESPONSE') || 
      errorMsg.includes('Navigation failed') && errorMsg.includes('code: -27')) {
    return;
  }
  
  console.error('❌ Uncaught exception:', error);
});

app.whenReady().then(async () => {
  electronApp.setAppUserModelId("com.electron");

  // Now connect the Puppeteer Manager (after app is ready)
  try {
    puppeteerManager = new PuppeteerManager();
    await puppeteerManager.initialize();
  } catch (error) {
    console.error("Failed to initialize Puppeteer Manager:", error);
    // Continue without Puppeteer if initialization fails
    puppeteerManager = null;
  }

  // Initialize Headless Browser for scheduled tasks
  try {
    headlessBrowserManager = new HeadlessBrowserManager();
    await headlessBrowserManager.initialize();
  } catch (error) {
    console.error('Failed to initialize Headless Browser:', error);
    headlessBrowserManager = null;
  }

  // Initialize Task Scheduler
  try {
    taskScheduler = new TaskScheduler();
    await taskScheduler.initialize();
    console.log('✅ Task Scheduler initialized');
  } catch (error) {
    console.error('Failed to initialize Task Scheduler:', error);
    taskScheduler = null;
  }

  // Create main window (passing scheduler for IPC handlers)
  mainWindow = createWindow(puppeteerManager || undefined, taskScheduler || undefined);

  // Connect scheduler to headless agent execution
  if (taskScheduler && headlessBrowserManager) {
    taskScheduler.on('execute-task', async (task, callback) => {
      try {
        console.log(`\n🔔 Executing scheduled task in headless mode: ${task.name}`);

        // Use headless agent executor
        const executor = new HeadlessAgentExecutor(headlessBrowserManager!);
        const result = await executor.execute(task.prompt);

        // Show system notification
        showTaskNotification(task.name, result.success, result.output);

        callback({
          success: result.success,
          output: result.output
        });
      } catch (error) {
        console.error('Failed to execute scheduled task:', error);
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Show error notification
        showTaskNotification(task.name, false, errorMsg);

        callback({
          success: false,
          output: errorMsg
        });
      }
    });

    console.log('✅ Task Scheduler connected to headless agent');
  }

  /**
   * Show system notification for task completion
   */
  function showTaskNotification(taskName: string, success: boolean, output: string) {
    if (!Notification.isSupported()) return;

    const notification = new Notification({
      title: success ? `✅ Task Completed: ${taskName}` : `❌ Task Failed: ${taskName}`,
      body: output.length > 100 ? output.substring(0, 100) + '...' : output,
      icon: success ? undefined : undefined, // Can add icon paths here
      sound: 'default'
    });

    notification.show();

    // Handle notification click - bring app to front and show tasks tab
    notification.on('click', () => {
      if (mainWindow) {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          if (win.isMinimized()) win.restore();
          win.focus();
        }
      }
    });
  }

  app.on("activate", () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow(puppeteerManager || undefined, taskScheduler || undefined);
    }
  });
});

app.on("window-all-closed", () => {
  if (eventManager) {
    eventManager.cleanup();
    eventManager = null;
  }

  // Clean up Puppeteer Manager
  if (puppeteerManager) {
    puppeteerManager.cleanup();
    puppeteerManager = null;
  }

  // Clean up Task Scheduler
  if (taskScheduler) {
    taskScheduler.shutdown();
    taskScheduler = null;
  }

  // Clean up Headless Browser
  if (headlessBrowserManager) {
    headlessBrowserManager.cleanup().catch(err => console.error('Error cleaning up headless browser:', err));
    headlessBrowserManager = null;
  }

  // Clean up references
  if (mainWindow) {
    mainWindow = null;
  }
  if (menu) {
    menu = null;
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Export for use in other modules
export { puppeteerManager };
