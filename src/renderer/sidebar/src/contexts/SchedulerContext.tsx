import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'

interface TaskSchedule {
  type: 'once' | 'delay' | 'recurring' | 'cron'
  executeAt?: Date
  delayMinutes?: number
  interval?: 'hourly' | 'daily' | 'weekly' | 'monthly'
  expression?: string
}

type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused'

interface ScheduledTask {
  id: string
  name: string
  description?: string
  prompt: string
  schedule: TaskSchedule
  status: TaskStatus
  createdAt: Date
  lastRun?: Date
  nextRun?: Date
  runCount: number
  maxRuns?: number
  enabled: boolean
  result?: {
    success: boolean
    output: string
    error?: string
    timestamp: Date
  }
}

interface SchedulerContextType {
  tasks: ScheduledTask[]
  isLoading: boolean
  refreshTasks: () => Promise<void>
  createTask: (taskData: {
    name: string
    description?: string
    prompt: string
    schedule: TaskSchedule
    maxRuns?: number
  }) => Promise<ScheduledTask>
  pauseTask: (taskId: string) => Promise<boolean>
  resumeTask: (taskId: string) => Promise<boolean>
  cancelTask: (taskId: string) => Promise<boolean>
  executeNow: (taskId: string) => Promise<boolean>
}

const SchedulerContext = createContext<SchedulerContextType | undefined>(undefined)

export const SchedulerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refreshTasks = useCallback(async () => {
    try {
      const allTasks = await window.sidebarAPI.scheduler.getAllTasks()
      setTasks(allTasks)
    } catch (error) {
      console.error('Failed to load tasks:', error)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const createTask = useCallback(async (taskData: any) => {
    const task = await window.sidebarAPI.scheduler.createTask(taskData)
    await refreshTasks()
    return task
  }, [refreshTasks])

  const pauseTask = useCallback(async (taskId: string) => {
    const result = await window.sidebarAPI.scheduler.pauseTask(taskId)
    if (result) await refreshTasks()
    return result
  }, [refreshTasks])

  const resumeTask = useCallback(async (taskId: string) => {
    const result = await window.sidebarAPI.scheduler.resumeTask(taskId)
    if (result) await refreshTasks()
    return result
  }, [refreshTasks])

  const cancelTask = useCallback(async (taskId: string) => {
    const result = await window.sidebarAPI.scheduler.cancelTask(taskId)
    if (result) await refreshTasks()
    return result
  }, [refreshTasks])

  const executeNow = useCallback(async (taskId: string) => {
    return await window.sidebarAPI.scheduler.executeNow(taskId)
  }, [])

  // Initial load
  useEffect(() => {
    refreshTasks()
  }, [refreshTasks])

  // Real-time event listeners
  useEffect(() => {
    window.sidebarAPI.scheduler.onTaskCreated(() => refreshTasks())
    window.sidebarAPI.scheduler.onTaskUpdated(() => refreshTasks())
    window.sidebarAPI.scheduler.onTaskStarted(() => refreshTasks())
    window.sidebarAPI.scheduler.onTaskCompleted(() => refreshTasks())
    window.sidebarAPI.scheduler.onTaskFailed(() => refreshTasks())
    window.sidebarAPI.scheduler.onTaskPaused(() => refreshTasks())
    window.sidebarAPI.scheduler.onTaskResumed(() => refreshTasks())

    // Cleanup is not provided by the API yet, but tasks will auto-refresh
    return () => {
      // No cleanup needed - IPC listeners are persistent
    }
  }, [refreshTasks])

  const value: SchedulerContextType = {
    tasks,
    isLoading,
    refreshTasks,
    createTask,
    pauseTask,
    resumeTask,
    cancelTask,
    executeNow
  }

  return (
    <SchedulerContext.Provider value={value}>
      {children}
    </SchedulerContext.Provider>
  )
}

export const useScheduler = () => {
  const context = useContext(SchedulerContext)
  if (!context) {
    throw new Error('useScheduler must be used within a SchedulerProvider')
  }
  return context
}
