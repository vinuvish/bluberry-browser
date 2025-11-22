import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';

/**
 * Task Schedule Types
 */
export type TaskSchedule =
  | { type: 'once'; executeAt: Date }
  | { type: 'delay'; delayMinutes: number }
  | { type: 'recurring'; interval?: 'hourly' | 'daily' | 'weekly' | 'monthly'; intervalMinutes?: number }
  | { type: 'cron'; expression: string }; // e.g., "0 9 * * 1-5" = weekdays at 9am

/**
 * Task Status
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';

/**
 * Scheduled Task Definition
 */
export interface ScheduledTask {
  id: string;
  name: string;
  description?: string;
  prompt: string; // The task for the agent to execute
  schedule: TaskSchedule;
  status: TaskStatus;
  createdAt: Date;
  lastRun?: Date;
  nextRun?: Date;
  runCount: number;
  maxRuns?: number; // For recurring tasks, limit total runs
  enabled: boolean;
  result?: {
    success: boolean;
    output: string;
    error?: string;
    timestamp: Date;
  };
}

/**
 * Task Scheduler Service
 * Manages scheduled automation tasks with support for one-time, delayed, and recurring execution
 */
export class TaskScheduler extends EventEmitter {
  private tasks: Map<string, ScheduledTask> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private storageFile: string;
  private isInitialized = false;

  constructor() {
    super();
    this.storageFile = path.join(app.getPath('userData'), 'scheduled-tasks.json');
  }

  /**
   * Initialize scheduler - load persisted tasks and start scheduling
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📅 Initializing Task Scheduler...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await this.loadTasks();

    if (this.tasks.size > 0) {
      console.log(`\n🔄 Re-scheduling ${this.tasks.size} task(s)...\n`);
      this.scheduleAllTasks();
    }

    this.isInitialized = true;
    console.log(`\n✅ Task Scheduler initialized with ${this.tasks.size} task(s)\n`);
  }

  /**
   * Create a new scheduled task
   */
  async createTask(task: Omit<ScheduledTask, 'id' | 'createdAt' | 'status' | 'runCount' | 'enabled'>): Promise<ScheduledTask> {
    const newTask: ScheduledTask = {
      ...task,
      id: this.generateTaskId(),
      createdAt: new Date(),
      status: 'pending',
      runCount: 0,
      enabled: true,
      nextRun: this.calculateNextRun(task.schedule)
    };

    this.tasks.set(newTask.id, newTask);
    await this.saveTasks();

    this.scheduleTask(newTask);

    this.emit('task-created', newTask);
    console.log(`✅ Created scheduled task: ${newTask.name} (${newTask.id})`);

    return newTask;
  }

  /**
   * Get all scheduled tasks
   */
  getAllTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get task by ID
   */
  getTask(taskId: string): ScheduledTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Update task
   */
  async updateTask(taskId: string, updates: Partial<ScheduledTask>): Promise<ScheduledTask | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    const updatedTask = { ...task, ...updates };
    this.tasks.set(taskId, updatedTask);
    await this.saveTasks();

    // Reschedule if schedule or enabled status changed
    if (updates.schedule || updates.enabled !== undefined) {
      this.cancelTaskTimer(taskId);
      if (updatedTask.enabled) {
        updatedTask.nextRun = this.calculateNextRun(updatedTask.schedule);
        this.scheduleTask(updatedTask);
      }
    }

    this.emit('task-updated', updatedTask);
    return updatedTask;
  }

  /**
   * Pause a task
   */
  async pauseTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    task.enabled = false;
    task.status = 'paused';
    this.cancelTaskTimer(taskId);
    await this.saveTasks();

    this.emit('task-paused', task);
    console.log(`⏸️  Paused task: ${task.name}`);
    return true;
  }

  /**
   * Resume a paused task
   */
  async resumeTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    task.enabled = true;
    task.status = 'pending';
    task.nextRun = this.calculateNextRun(task.schedule);
    this.scheduleTask(task);
    await this.saveTasks();

    this.emit('task-resumed', task);
    console.log(`▶️  Resumed task: ${task.name}`);
    return true;
  }

  /**
   * Cancel a task (delete it)
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    this.cancelTaskTimer(taskId);
    this.tasks.delete(taskId);
    await this.saveTasks();

    this.emit('task-cancelled', task);
    console.log(`❌ Cancelled task: ${task.name}`);
    return true;
  }

  /**
   * Execute a task immediately (manual trigger)
   */
  async executeTaskNow(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    console.log(`🚀 Manually executing task: ${task.name}`);
    await this.executeTask(task);
  }

  /**
   * Schedule all enabled tasks
   */
  private scheduleAllTasks(): void {
    for (const task of this.tasks.values()) {
      if (task.enabled && task.status !== 'cancelled') {
        this.scheduleTask(task);
      }
    }
  }

  /**
   * Schedule a single task
   */
  private scheduleTask(task: ScheduledTask): void {
    // Clear existing timer if any
    this.cancelTaskTimer(task.id);

    const nextRun = this.calculateNextRun(task.schedule);
    if (!nextRun) {
      console.warn(`⚠️  Could not calculate next run for task: ${task.name}`);
      return;
    }

    task.nextRun = nextRun;
    const delay = nextRun.getTime() - Date.now();

    if (delay < 0) {
      // Task is overdue, execute immediately
      console.log(`⏰ Task overdue, executing now: ${task.name}`);
      this.executeTask(task);
      return;
    }

    // Schedule task execution
    const timer = setTimeout(() => {
      this.executeTask(task);
    }, delay);

    this.timers.set(task.id, timer);

    const delayMinutes = Math.round(delay / 60000);
    console.log(`⏰ Scheduled "${task.name}" to run in ${delayMinutes} minute(s) at ${nextRun.toLocaleString()}`);
  }

  /**
   * Execute a scheduled task
   */
  private async executeTask(task: ScheduledTask): Promise<void> {
    console.log(`\n🔔 EXECUTING SCHEDULED TASK: ${task.name}`);
    console.log(`   Prompt: ${task.prompt}`);

    task.status = 'running';
    task.lastRun = new Date();
    task.runCount++;

    // Save immediately to persist running status
    await this.saveTasks();
    this.emit('task-started', task);

    try {
      // Emit event for execution - the main process will handle this
      // by creating an AgentOrchestrator and running the task
      const result = await new Promise<{ success: boolean; output: string }>((resolve) => {
        this.emit('execute-task', task, resolve);
      });

      task.result = {
        success: result.success,
        output: result.output,
        timestamp: new Date()
      };

      task.status = result.success ? 'completed' : 'failed';

      console.log(`✅ Task completed: ${task.name}`);
      this.emit('task-completed', task);

    } catch (error) {
      console.error(`❌ Task failed: ${task.name}`, error);

      task.result = {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date()
      };
      task.status = 'failed';

      this.emit('task-failed', task, error);
    }

    await this.saveTasks();

    // Schedule next run for recurring tasks
    if (this.isRecurringTask(task.schedule) && task.enabled) {
      // Check if max runs reached
      if (task.maxRuns && task.runCount >= task.maxRuns) {
        console.log(`🏁 Task "${task.name}" reached max runs (${task.maxRuns}), stopping.`);
        task.enabled = false;
        task.status = 'completed';
        await this.saveTasks();
        return;
      }

      // Schedule next occurrence
      task.status = 'pending';
      this.scheduleTask(task);
    } else {
      // One-time task - mark as completed
      task.enabled = false;
    }
  }

  /**
   * Calculate next run time based on schedule
   */
  private calculateNextRun(schedule: TaskSchedule): Date | undefined {
    const now = new Date();

    switch (schedule.type) {
      case 'once':
        return new Date(schedule.executeAt);

      case 'delay':
        return new Date(now.getTime() + schedule.delayMinutes * 60000);

      case 'recurring':
        return this.calculateRecurringNextRun(schedule, now);

      case 'cron':
        return this.calculateCronNextRun(schedule.expression, now);

      default:
        return undefined;
    }
  }

  /**
   * Calculate next run for recurring tasks
   */
  private calculateRecurringNextRun(schedule: TaskSchedule, from: Date): Date {
    if (schedule.type !== 'recurring') {
      throw new Error('Invalid schedule type for recurring calculation');
    }

    const next = new Date(from);

    // If intervalMinutes is specified, use that for precise interval control
    if (schedule.intervalMinutes !== undefined) {
      next.setMinutes(next.getMinutes() + schedule.intervalMinutes);
      return next;
    }

    // Otherwise use the preset interval strings
    const interval = schedule.interval;
    switch (interval) {
      case 'hourly':
        next.setHours(next.getHours() + 1);
        break;
      case 'daily':
        next.setDate(next.getDate() + 1);
        break;
      case 'weekly':
        next.setDate(next.getDate() + 7);
        break;
      case 'monthly':
        next.setMonth(next.getMonth() + 1);
        break;
      default:
        // Default to 1 hour if no interval specified
        next.setHours(next.getHours() + 1);
    }

    return next;
  }

  /**
   * Simple cron expression parser
   * Format: "minute hour dayOfMonth month dayOfWeek"
   * Examples:
   *   "0 9 * * *" = daily at 9:00 AM
   *   "1 * * * *" = every hour at minute 1 (hourly)
   *   "star/5 * * * *" = every 5 minutes (replace 'star' with *)
   */
  private calculateCronNextRun(expression: string, from: Date): Date | undefined {
    try {
      const parts = expression.split(' ');
      if (parts.length !== 5) return undefined;

      const minutePart = parts[0];
      const hourPart = parts[1];

      const next = new Date(from);
      next.setSeconds(0);
      next.setMilliseconds(0);

      // Handle "*/N" syntax for intervals (e.g., "*/5" = every 5 minutes)
      if (minutePart.startsWith('*/')) {
        const interval = parseInt(minutePart.substring(2));
        if (!isNaN(interval) && interval > 0) {
          // Add interval minutes to current time
          const nextMinute = Math.ceil((next.getMinutes() + 1) / interval) * interval;
          if (nextMinute >= 60) {
            next.setHours(next.getHours() + Math.floor(nextMinute / 60));
            next.setMinutes(nextMinute % 60);
          } else {
            next.setMinutes(nextMinute);
          }
          return next;
        }
      }

      // Parse minute and hour
      const minute = minutePart === '*' ? -1 : parseInt(minutePart);
      const hour = hourPart === '*' ? -1 : parseInt(hourPart);

      // Validate parsed values
      if (minute < -1 || minute > 59 || hour < -1 || hour > 23) {
        console.error(`Invalid cron values: minute=${minute}, hour=${hour}`);
        return undefined;
      }

      // Case 1: Both minute and hour specified (e.g., "30 9 * * *" = 9:30 AM daily)
      if (minute >= 0 && hour >= 0) {
        next.setMinutes(minute);
        next.setHours(hour);

        // If time has passed today, schedule for tomorrow
        if (next <= from) {
          next.setDate(next.getDate() + 1);
        }
        return next;
      }

      // Case 2: Only minute specified, hour is wildcard (e.g., "1 * * * *" = hourly at minute 1)
      if (minute >= 0 && hour === -1) {
        next.setMinutes(minute);

        // If current minute >= target minute, go to next hour
        if (from.getMinutes() >= minute) {
          next.setHours(next.getHours() + 1);
        }
        return next;
      }

      // Case 3: Only hour specified, minute is wildcard (e.g., "* 9 * * *" = every minute during 9 AM)
      if (minute === -1 && hour >= 0) {
        next.setHours(hour);
        next.setMinutes(next.getMinutes() + 1);

        // If hour has passed today, schedule for tomorrow
        if (next.getHours() !== hour) {
          next.setDate(next.getDate() + 1);
          next.setHours(hour);
          next.setMinutes(0);
        }
        return next;
      }

      // Case 4: Both wildcards (e.g., "* * * * *" = every minute)
      if (minute === -1 && hour === -1) {
        next.setMinutes(next.getMinutes() + 1);
        return next;
      }

      return undefined;
    } catch (error) {
      console.error('Failed to parse cron expression:', expression, error);
      return undefined;
    }
  }

  /**
   * Check if task is recurring
   */
  private isRecurringTask(schedule: TaskSchedule): boolean {
    return schedule.type === 'recurring' || schedule.type === 'cron';
  }

  /**
   * Cancel task timer
   */
  private cancelTaskTimer(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
  }

  /**
   * Generate unique task ID
   */
  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Load tasks from disk
   */
  private async loadTasks(): Promise<void> {
    try {
      console.log(`📂 Loading tasks from: ${this.storageFile}`);
      const data = await fs.readFile(this.storageFile, 'utf-8');
      const tasks: ScheduledTask[] = JSON.parse(data);

      for (const task of tasks) {
        // Convert date strings back to Date objects
        task.createdAt = new Date(task.createdAt);
        if (task.lastRun) task.lastRun = new Date(task.lastRun);
        if (task.nextRun) task.nextRun = new Date(task.nextRun);
        if (task.result?.timestamp) task.result.timestamp = new Date(task.result.timestamp);
        if (task.schedule.type === 'once') {
          task.schedule.executeAt = new Date(task.schedule.executeAt);
        }

        this.tasks.set(task.id, task);
      }

      console.log(`✅ Loaded ${tasks.length} scheduled task(s) from disk`);

      // Log task details
      if (tasks.length > 0) {
        tasks.forEach(task => {
          const status = task.enabled ? '🟢 Enabled' : '⏸️  Paused';
          console.log(`   ${status} - "${task.name}" (${task.schedule.type})`);
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log('📂 No existing tasks file found, starting fresh');
      } else {
        console.error('❌ Failed to load tasks:', error);
      }
    }
  }

  /**
   * Save tasks to disk
   */
  private async saveTasks(): Promise<void> {
    try {
      const tasks = Array.from(this.tasks.values());
      await fs.writeFile(this.storageFile, JSON.stringify(tasks, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to save tasks:', error);
    }
  }

  /**
   * Shutdown scheduler - cleanup timers
   */
  shutdown(): void {
    console.log('📅 Shutting down Task Scheduler...');

    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }

    this.timers.clear();
    this.isInitialized = false;
  }
}
