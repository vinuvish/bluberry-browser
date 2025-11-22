import React, { useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@common/components/Button'
import { cn } from '@common/lib/utils'

interface TaskSchedule {
  type: 'once' | 'delay' | 'recurring' | 'cron'
  executeAt?: Date
  delayMinutes?: number
  interval?: 'hourly' | 'daily' | 'weekly' | 'monthly'
  expression?: string
}

interface CreateTaskFormProps {
  onSubmit: (taskData: {
    name: string
    description?: string
    prompt: string
    schedule: TaskSchedule
    maxRuns?: number
  }) => Promise<void>
  onCancel: () => void
}

export const CreateTaskForm: React.FC<CreateTaskFormProps> = ({ onSubmit, onCancel }) => {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [scheduleType, setScheduleType] = useState<'once' | 'delay' | 'recurring' | 'cron'>('delay')
  const [delayMinutes, setDelayMinutes] = useState(5)
  const [executeAt, setExecuteAt] = useState('')
  const [interval, setInterval] = useState<'hourly' | 'daily' | 'weekly' | 'monthly'>('hourly')
  const [cronExpression, setCronExpression] = useState('0 9 * * *')
  const [maxRuns, setMaxRuns] = useState<number | undefined>(undefined)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!name || !prompt) return

    setIsSubmitting(true)

    try {
      let schedule: TaskSchedule

      switch (scheduleType) {
        case 'once':
          schedule = {
            type: 'once',
            executeAt: new Date(executeAt)
          }
          break
        case 'delay':
          schedule = {
            type: 'delay',
            delayMinutes
          }
          break
        case 'recurring':
          schedule = {
            type: 'recurring',
            interval
          }
          break
        case 'cron':
          schedule = {
            type: 'cron',
            expression: cronExpression
          }
          break
      }

      await onSubmit({
        name,
        description: description || undefined,
        prompt,
        schedule,
        maxRuns: maxRuns || undefined
      })

      // Reset form
      setName('')
      setDescription('')
      setPrompt('')
      setDelayMinutes(5)
      setMaxRuns(undefined)
    } catch (error) {
      console.error('Failed to create task:', error)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="border border-border rounded-lg bg-card">
      <div className="border-b border-border p-4 flex items-center justify-between">
        <h3 className="font-semibold text-foreground">Create New Task</h3>
        <Button variant="ghost" size="sm" onClick={onCancel} className="h-8 w-8 p-0">
          <X className="w-4 h-4" />
        </Button>
      </div>

      <form onSubmit={handleSubmit} className="p-4 space-y-4">
        {/* Task Name */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Task Name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Check Gmail"
            className="w-full px-3 py-2 bg-background border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            required
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Description
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description"
            className="w-full px-3 py-2 bg-background border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        {/* Prompt */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Agent Prompt <span className="text-red-500">*</span>
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the agent do? e.g., Navigate to Gmail and check for unread emails"
            rows={3}
            className="w-full px-3 py-2 bg-background border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary resize-none"
            required
          />
        </div>

        {/* Schedule Type */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            Schedule Type
          </label>
          <div className="grid grid-cols-2 gap-2">
            {(['delay', 'once', 'recurring', 'cron'] as const).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setScheduleType(type)}
                className={cn(
                  "px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  scheduleType === type
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                )}
              >
                {type.charAt(0).toUpperCase() + type.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Schedule Configuration */}
        <div className="space-y-3">
          {scheduleType === 'delay' && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Delay (minutes)
              </label>
              <input
                type="number"
                value={delayMinutes}
                onChange={(e) => setDelayMinutes(parseInt(e.target.value) || 0)}
                min="1"
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          )}

          {scheduleType === 'once' && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Execute At
              </label>
              <input
                type="datetime-local"
                value={executeAt}
                onChange={(e) => setExecuteAt(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                required
              />
            </div>
          )}

          {scheduleType === 'recurring' && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Interval
              </label>
              <select
                value={interval}
                onChange={(e) => setInterval(e.target.value as any)}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
          )}

          {scheduleType === 'cron' && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Cron Expression
              </label>
              <input
                type="text"
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                placeholder="0 9 * * *"
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-foreground font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Format: minute hour day month weekday
              </p>
            </div>
          )}
        </div>

        {/* Max Runs (for recurring tasks) */}
        {(scheduleType === 'recurring' || scheduleType === 'cron') && (
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Max Runs (optional)
            </label>
            <input
              type="number"
              value={maxRuns || ''}
              onChange={(e) => setMaxRuns(e.target.value ? parseInt(e.target.value) : undefined)}
              min="1"
              placeholder="Unlimited"
              className="w-full px-3 py-2 bg-background border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Leave empty for unlimited runs
            </p>
          </div>
        )}

        {/* Submit Button */}
        <div className="flex gap-2">
          <Button
            type="submit"
            disabled={isSubmitting || !name || !prompt}
            className="flex-1"
          >
            {isSubmitting ? 'Creating...' : 'Create Task'}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  )
}
