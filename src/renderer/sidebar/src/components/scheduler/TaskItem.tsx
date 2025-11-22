import React, { useState } from 'react'
import { Play, Pause, Trash2, Clock, Calendar, Repeat, Timer, ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import { Button } from '@common/components/Button'
import { cn } from '@common/lib/utils'

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

interface TaskItemProps {
  task: ScheduledTask
  onPause: (id: string) => void
  onResume: (id: string) => void
  onDelete: (id: string) => void
  onExecute: (id: string) => void
}

const getScheduleIcon = (type: string) => {
  switch (type) {
    case 'once': return Clock
    case 'delay': return Timer
    case 'recurring': return Repeat
    case 'cron': return Calendar
    default: return Clock
  }
}

const getScheduleText = (schedule: TaskSchedule) => {
  switch (schedule.type) {
    case 'once':
      return schedule.executeAt ? new Date(schedule.executeAt).toLocaleString() : 'Once'
    case 'delay':
      return `In ${schedule.delayMinutes} min`
    case 'recurring':
      return schedule.interval ? schedule.interval.charAt(0).toUpperCase() + schedule.interval.slice(1) : 'Recurring'
    case 'cron':
      return `Cron: ${schedule.expression}`
    default:
      return 'Unknown'
  }
}

const getStatusBadge = (status: TaskStatus, enabled: boolean) => {
  if (!enabled) return 'bg-yellow-500/10 text-yellow-500'
  switch (status) {
    case 'running': return 'bg-blue-500/10 text-blue-500'
    case 'completed': return 'bg-green-500/10 text-green-500'
    case 'failed': return 'bg-red-500/10 text-red-500'
    case 'pending': return 'bg-gray-500/10 text-gray-500'
    default: return 'bg-gray-400/10 text-gray-400'
  }
}

export const TaskItem: React.FC<TaskItemProps> = ({ task, onPause, onResume, onDelete, onExecute }) => {
  const [isExpanded, setIsExpanded] = useState(false)
  const ScheduleIcon = getScheduleIcon(task.schedule.type)

  const isRunning = task.status === 'running'

  return (
    <div className={cn(
      "border rounded-lg p-4 bg-card hover:bg-muted/50 transition-colors",
      isRunning && "border-blue-500/50 shadow-lg shadow-blue-500/10"
    )}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-medium text-foreground truncate">{task.name}</h3>
            <span className={cn(
              "text-xs px-2 py-0.5 rounded-full font-medium flex items-center gap-1",
              getStatusBadge(task.status, task.enabled),
              isRunning && "animate-pulse"
            )}>
              {isRunning && <Loader2 className="w-3 h-3 animate-spin" />}
              {!task.enabled ? 'Paused' : task.status}
            </span>
          </div>

          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <div className="flex items-center gap-1">
              <ScheduleIcon className="w-3 h-3" />
              <span>{getScheduleText(task.schedule)}</span>
            </div>
            <div>
              Runs: {task.runCount}{task.maxRuns ? `/${task.maxRuns}` : ''}
            </div>
          </div>

          {isRunning && (
            <div className="text-xs text-blue-500 font-medium mt-1 flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Task is running...</span>
            </div>
          )}
          {task.nextRun && task.enabled && !isRunning && (
            <div className="text-xs text-muted-foreground mt-1">
              Next: {new Date(task.nextRun).toLocaleString()}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onExecute(task.id)}
            disabled={isRunning}
            className={cn(
              "h-8 w-8 p-0",
              isRunning && "opacity-50 cursor-not-allowed"
            )}
            title={isRunning ? "Task is running..." : "Run now"}
          >
            {isRunning ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
          </Button>

          {task.enabled && !isRunning ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onPause(task.id)}
              className="h-8 w-8 p-0"
              title="Pause"
            >
              <Pause className="w-4 h-4" />
            </Button>
          ) : !isRunning ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onResume(task.id)}
              className="h-8 w-8 p-0 text-green-500"
              title="Resume"
            >
              <Play className="w-4 h-4" />
            </Button>
          ) : null}

          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete(task.id)}
            disabled={isRunning}
            className={cn(
              "h-8 w-8 p-0 text-red-500 hover:text-red-600",
              isRunning && "opacity-50 cursor-not-allowed"
            )}
            title={isRunning ? "Cannot delete while running" : "Delete"}
          >
            <Trash2 className="w-4 h-4" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsExpanded(!isExpanded)}
            className="h-8 w-8 p-0"
          >
            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        </div>
      </div>

      {/* Expanded Details */}
      {isExpanded && (
        <div className="mt-3 pt-3 border-t border-border space-y-2 text-sm">
          {task.description && (
            <div>
              <span className="text-muted-foreground">Description:</span>
              <p className="text-foreground mt-1">{task.description}</p>
            </div>
          )}

          <div>
            <span className="text-muted-foreground">Prompt:</span>
            <p className="text-foreground mt-1 bg-muted/50 p-2 rounded text-xs font-mono">
              {task.prompt}
            </p>
          </div>

          {task.lastRun && (
            <div>
              <span className="text-muted-foreground">Last run:</span>
              <p className="text-foreground">{new Date(task.lastRun).toLocaleString()}</p>
            </div>
          )}

          {task.result && (
            <div>
              <span className={cn(
                "font-medium",
                task.result.success ? "text-green-500" : "text-red-500"
              )}>
                Last result: {task.result.success ? 'Success' : 'Failed'}
              </span>
              <p className="text-foreground mt-1 bg-muted/50 p-2 rounded text-xs max-h-32 overflow-y-auto">
                {task.result.output || task.result.error}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {new Date(task.result.timestamp).toLocaleString()}
              </p>
            </div>
          )}

          <div className="text-xs text-muted-foreground">
            Created: {new Date(task.createdAt).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  )
}
