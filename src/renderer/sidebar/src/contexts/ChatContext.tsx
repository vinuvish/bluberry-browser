import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'

interface Message {
    id: string
    role: 'user' | 'assistant'
    content: string
    timestamp: number
    isStreaming?: boolean
}

interface AgentProgress {
    agentId: string
    tabId: string
    status: 'idle' | 'working' | 'completed' | 'error'
    progress: number
    currentThought?: string
    currentAction?: string
    currentUrl?: string
}

interface ChatContextType {
    messages: Message[]
    isLoading: boolean
    agentMode: boolean
    agentProgress: Map<string, AgentProgress>
    agentPlan: any | null

    // Chat actions
    sendMessage: (content: string) => Promise<void>
    clearChat: () => void
    setAgentMode: (enabled: boolean) => void

    // Page content access
    getPageContent: () => Promise<string | null>
    getPageText: () => Promise<string | null>
    getCurrentUrl: () => Promise<string | null>
}

const ChatContext = createContext<ChatContextType | null>(null)

export const useChat = () => {
    const context = useContext(ChatContext)
    if (!context) {
        throw new Error('useChat must be used within a ChatProvider')
    }
    return context
}

export const ChatProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [messages, setMessages] = useState<Message[]>([])
    const [isLoading, setIsLoading] = useState(false)
    const [agentMode, setAgentMode] = useState(false)
    const [agentProgress, setAgentProgress] = useState<Map<string, AgentProgress>>(new Map())
    const [agentPlan, setAgentPlan] = useState<any | null>(null)

    // Load initial messages from main process
    useEffect(() => {
        const loadMessages = async () => {
            try {
                const storedMessages = await window.sidebarAPI.getMessages()
                if (storedMessages && storedMessages.length > 0) {
                    // Convert CoreMessage format to our frontend Message format
                    const convertedMessages = storedMessages.map((msg: any, index: number) => ({
                        id: `msg-${index}`,
                        role: msg.role,
                        content: typeof msg.content === 'string' 
                            ? msg.content 
                            : msg.content.find((p: any) => p.type === 'text')?.text || '',
                        timestamp: Date.now(),
                        isStreaming: false
                    }))
                    setMessages(convertedMessages)
                }
            } catch (error) {
                console.error('Failed to load messages:', error)
            }
        }
        loadMessages()
    }, [])

    const sendMessage = useCallback(async (content: string) => {
        setIsLoading(true)

        try {
            if (agentMode) {
                // Agent mode - execute autonomous task
                const userMessage: Message = {
                    id: `user-${Date.now()}`,
                    role: 'user',
                    content,
                    timestamp: Date.now()
                }
                setMessages(prev => [...prev, userMessage])

                const result = await window.sidebarAPI.executeAgent(content)

                const agentMessage: Message = {
                    id: `agent-${Date.now()}`,
                    role: 'assistant',
                    content: result.success ? result.output : `Error: ${result.error}`,
                    timestamp: Date.now()
                }
                setMessages(prev => [...prev, agentMessage])
            } else {
                // Normal chat mode
                const messageId = Date.now().toString()

                // Send message to main process (which will handle context)
                await window.sidebarAPI.sendChatMessage({
                    message: content,
                    messageId: messageId
                })

                // Messages will be updated via the chat-messages-updated event
            }
        } catch (error) {
            console.error('Failed to send message:', error)
        } finally {
            setIsLoading(false)
        }
    }, [agentMode])

    const clearChat = useCallback(async () => {
        try {
            await window.sidebarAPI.clearChat()
            await window.sidebarAPI.resetAgent()
            setMessages([])
            setAgentProgress(new Map())
            setAgentPlan(null)
        } catch (error) {
            console.error('Failed to clear chat:', error)
        }
    }, [])

    const getPageContent = useCallback(async () => {
        try {
            return await window.sidebarAPI.getPageContent()
        } catch (error) {
            console.error('Failed to get page content:', error)
            return null
        }
    }, [])

    const getPageText = useCallback(async () => {
        try {
            return await window.sidebarAPI.getPageText()
        } catch (error) {
            console.error('Failed to get page text:', error)
            return null
        }
    }, [])

    const getCurrentUrl = useCallback(async () => {
        try {
            return await window.sidebarAPI.getCurrentUrl()
        } catch (error) {
            console.error('Failed to get current URL:', error)
            return null
        }
    }, [])

    // Set up message listeners
    useEffect(() => {
        // Listen for streaming response updates
        const handleChatResponse = (data: { messageId: string; content: string; isComplete: boolean }) => {
            if (data.isComplete) {
                setIsLoading(false)
            }
        }

        // Listen for message updates from main process
        const handleMessagesUpdated = (updatedMessages: any[]) => {
            // Convert CoreMessage format to our frontend Message format
            const convertedMessages = updatedMessages.map((msg: any, index: number) => ({
                id: `msg-${index}`,
                role: msg.role,
                content: typeof msg.content === 'string'
                    ? msg.content
                    : msg.content.find((p: any) => p.type === 'text')?.text || '',
                timestamp: Date.now(),
                isStreaming: false
            }))
            setMessages(convertedMessages)
        }

        // Listen for agent progress updates
        const handleAgentProgress = (progress: AgentProgress) => {
            setAgentProgress(prev => {
                const updated = new Map(prev)
                updated.set(progress.agentId, progress)
                return updated
            })

            // Add progress as a message if there's a thought
            if (progress.currentThought && progress.status === 'working') {
                setMessages(prev => {
                    // Check if we already have a recent progress message to avoid duplicates
                    const lastMessage = prev[prev.length - 1]
                    if (lastMessage?.content === progress.currentThought) {
                        return prev
                    }

                    return [...prev, {
                        id: `progress-${Date.now()}`,
                        role: 'assistant',
                        content: `🤖 ${progress.currentThought}`,
                        timestamp: Date.now()
                    }]
                })
            }
        }

        // Listen for agent plan updates
        const handleAgentPlan = (plan: any) => {
            setAgentPlan(plan)

            // Add plan as a message
            if (plan && plan.taskName) {
                let planMessage = `📋 **Plan:** ${plan.taskName}\n\n`

                if (plan.parallelTasks && plan.parallelTasks.length > 0) {
                    planMessage += `Running ${plan.parallelTasks.length} tasks in parallel:\n`
                    plan.parallelTasks.forEach((task: any, i: number) => {
                        planMessage += `${i + 1}. ${task.description}\n`
                    })
                }

                if (plan.estimatedTime) {
                    planMessage += `\n⏱️ Estimated time: ${plan.estimatedTime}`
                }

                setMessages(prev => [...prev, {
                    id: `plan-${Date.now()}`,
                    role: 'assistant',
                    content: planMessage,
                    timestamp: Date.now()
                }])
            }
        }

        window.sidebarAPI.onChatResponse(handleChatResponse)
        window.sidebarAPI.onMessagesUpdated(handleMessagesUpdated)
        window.sidebarAPI.onAgentProgress(handleAgentProgress)
        window.sidebarAPI.onAgentPlanUpdate(handleAgentPlan)

        return () => {
            window.sidebarAPI.removeChatResponseListener()
            window.sidebarAPI.removeMessagesUpdatedListener()
            window.sidebarAPI.removeAgentProgressListener()
            window.sidebarAPI.removeAgentPlanListener()
        }
    }, [])

    const value: ChatContextType = {
        messages,
        isLoading,
        agentMode,
        agentProgress,
        agentPlan,
        sendMessage,
        clearChat,
        setAgentMode,
        getPageContent,
        getPageText,
        getCurrentUrl
    }

    return (
        <ChatContext.Provider value={value}>
            {children}
        </ChatContext.Provider>
    )
}

