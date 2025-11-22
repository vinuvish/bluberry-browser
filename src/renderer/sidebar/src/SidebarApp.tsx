import React, { useEffect, useState } from 'react'
import { MessageSquare, Calendar } from 'lucide-react'
import { ChatProvider } from './contexts/ChatContext'
import { SchedulerProvider } from './contexts/SchedulerContext'
import { Chat } from './components/Chat'
import { ScheduledTasks } from './components/scheduler/ScheduledTasks'
import { useDarkMode } from '@common/hooks/useDarkMode'
import { cn } from '@common/lib/utils'

type Tab = 'chat' | 'scheduler'

const SidebarContent: React.FC = () => {
    const { isDarkMode } = useDarkMode()
    const [activeTab, setActiveTab] = useState<Tab>('chat')

    // Apply dark mode class to the document
    useEffect(() => {
        if (isDarkMode) {
            document.documentElement.classList.add('dark')
        } else {
            document.documentElement.classList.remove('dark')
        }
    }, [isDarkMode])

    return (
        <div className="h-screen flex flex-col bg-background border-l border-border">
            {/* Tab Switcher */}
            <div className="flex-none border-b border-border bg-card">
                <div className="flex">
                    <button
                        onClick={() => setActiveTab('chat')}
                        className={cn(
                            "flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors",
                            activeTab === 'chat'
                                ? "text-primary border-b-2 border-primary bg-muted/50"
                                : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
                        )}
                    >
                        <MessageSquare className="w-4 h-4" />
                        <span>Chat</span>
                    </button>
                    <button
                        onClick={() => setActiveTab('scheduler')}
                        className={cn(
                            "flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors",
                            activeTab === 'scheduler'
                                ? "text-primary border-b-2 border-primary bg-muted/50"
                                : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
                        )}
                    >
                        <Calendar className="w-4 h-4" />
                        <span>Tasks</span>
                    </button>
                </div>
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-hidden">
                {activeTab === 'chat' && <Chat />}
                {activeTab === 'scheduler' && <ScheduledTasks />}
            </div>
        </div>
    )
}

export const SidebarApp: React.FC = () => {
    return (
        <ChatProvider>
            <SchedulerProvider>
                <SidebarContent />
            </SchedulerProvider>
        </ChatProvider>
    )
}

