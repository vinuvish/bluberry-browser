import React, { useState } from 'react'
import { Plus, RefreshCw, Calendar, Filter, Loader2 } from 'lucide-react'
import { Button } from '@common/components/Button'
import { useScheduler } from '../../contexts/SchedulerContext'
import { TaskItem } from './TaskItem'
import { CreateTaskForm } from './CreateTaskForm'
import { cn } from '@common/lib/utils'

type FilterType = 'all' | 'active' | 'paused' | 'completed' | 'failed'

export const ScheduledTasks: React.FC = () => {
  const { tasks, isLoading, refreshTasks, createTask, pauseTask, resumeTask, cancelTask, executeNow } = useScheduler()
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [filter, setFilter] = useState<FilterType>('all')
  const [isRefreshing, setIsRefreshing] = useState(false)

  const handleRefresh = async () => {
    setIsRefreshing(true)
    await refreshTasks()
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const handleCreateTask = async (taskData: any) => {
    await createTask(taskData)
    setShowCreateForm(false)
  }

  const handlePause = async (id: string) => {
    await pauseTask(id)
  }

  const handleResume = async (id: string) => {
    await resumeTask(id)
  }

  const handleDelete = async (id: string) => {
    if (confirm('Are you sure you want to delete this task?')) {
      await cancelTask(id)
    }
  }

  const handleExecute = async (id: string) => {
    await executeNow(id)
  }

  // Filter tasks
  const filteredTasks = tasks.filter(task => {
    switch (filter) {
      case 'active':
        return task.enabled && task.status !== 'completed'
      case 'paused':
        return !task.enabled || task.status === 'paused'
      case 'completed':
        return task.status === 'completed'
      case 'failed':
        return task.status === 'failed'
      default:
        return true
    }
  })

  // Calculate stats
  const stats = {
    total: tasks.length,
    active: tasks.filter(t => t.enabled && t.status !== 'completed' && t.status !== 'running').length,
    running: tasks.filter(t => t.status === 'running').length,
    paused: tasks.filter(t => !t.enabled || t.status === 'paused').length,
    completed: tasks.filter(t => t.status === 'completed').length,
    failed: tasks.filter(t => t.status === 'failed').length
  }

  // Get running tasks
  const runningTasks = tasks.filter(t => t.status === 'running')

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex-none border-b border-border bg-card">
        <div className="p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Calendar className="w-5 h-5 text-primary" />
              <h2 className="text-lg font-semibold text-foreground">Scheduled Tasks</h2>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRefresh}
                disabled={isRefreshing}
                className="h-8 w-8 p-0"
                title="Refresh"
              >
                <RefreshCw className={cn("w-4 h-4", isRefreshing && "animate-spin")} />
              </Button>
              <Button
                size="sm"
                onClick={() => setShowCreateForm(true)}
                className="h-8 gap-1"
              >
                <Plus className="w-4 h-4" />
                <span className="hidden sm:inline">New Task</span>
              </Button>
            </div>
          </div>

          {/* Stats */}
          <div className={cn(
            "grid gap-2 text-center",
            stats.running > 0 ? "grid-cols-6" : "grid-cols-5"
          )}>
            <div className="bg-muted/50 rounded-md p-2">
              <div className="text-xs text-muted-foreground">Total</div>
              <div className="text-lg font-semibold text-foreground">{stats.total}</div>
            </div>
            <div className="bg-blue-500/10 rounded-md p-2">
              <div className="text-xs text-blue-500">Active</div>
              <div className="text-lg font-semibold text-blue-500">{stats.active}</div>
            </div>
            {stats.running > 0 && (
              <div className="bg-purple-500/10 rounded-md p-2 border border-purple-500/20">
                <div className="text-xs text-purple-500 flex items-center justify-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Running
                </div>
                <div className="text-lg font-semibold text-purple-500">{stats.running}</div>
              </div>
            )}
            <div className="bg-yellow-500/10 rounded-md p-2">
              <div className="text-xs text-yellow-500">Paused</div>
              <div className="text-lg font-semibold text-yellow-500">{stats.paused}</div>
            </div>
            <div className="bg-green-500/10 rounded-md p-2">
              <div className="text-xs text-green-500">Done</div>
              <div className="text-lg font-semibold text-green-500">{stats.completed}</div>
            </div>
            <div className="bg-red-500/10 rounded-md p-2">
              <div className="text-xs text-red-500">Failed</div>
              <div className="text-lg font-semibold text-red-500">{stats.failed}</div>
            </div>
          </div>

          {/* Filters */}
          <div className="mt-3 flex items-center gap-2 overflow-x-auto">
            <Filter className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            {(['all', 'active', 'paused', 'completed', 'failed'] as FilterType[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors",
                  filter === f
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                )}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Sticky Running Tasks Banner */}
      {runningTasks.length > 0 && (
        <div className="flex-none sticky top-0 z-20 bg-purple-500/10 border-b border-purple-500/20 px-4 py-2 shadow-sm">
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-purple-500" />
            <span className="text-sm font-medium text-purple-500">
              {runningTasks.length} task{runningTasks.length > 1 ? 's' : ''} running
            </span>
            <div className="flex-1" />
            <div className="flex items-center gap-2 text-xs text-purple-500/80">
              {runningTasks.slice(0, 3).map((task) => (
                <span key={task.id} className="truncate max-w-[150px]" title={task.name}>
                  {task.name}
                </span>
              ))}
              {runningTasks.length > 3 && (
                <span>+{runningTasks.length - 3} more</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {showCreateForm && (
          <div className="p-4 border-b border-border bg-background sticky top-0 z-10">
            <CreateTaskForm
              onSubmit={handleCreateTask}
              onCancel={() => setShowCreateForm(false)}
            />
          </div>
        )}

        <div className="p-4 space-y-3">
          {isLoading ? (
            <div className="text-center py-12 text-muted-foreground">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2" />
              <p>Loading tasks...</p>
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="text-center py-12">
              <Calendar className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-50" />
              <p className="text-muted-foreground mb-4">
                {filter === 'all'
                  ? 'No scheduled tasks yet'
                  : `No ${filter} tasks`
                }
              </p>
              {filter === 'all' && !showCreateForm && (
                <Button onClick={() => setShowCreateForm(true)} size="sm">
                  <Plus className="w-4 h-4 mr-1" />
                  Create Your First Task
                </Button>
              )}
            </div>
          ) : (
            filteredTasks.map((task) => (
              <TaskItem
                key={task.id}
                task={task}
                onPause={handlePause}
                onResume={handleResume}
                onDelete={handleDelete}
                onExecute={handleExecute}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
