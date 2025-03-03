import PomodoroTimerPlugin from 'main'
import { type CachedMetadata, type TFile, type App } from 'obsidian'
import { extractTaskComponents } from 'utils'
import { writable, derived, type Readable, type Writable } from 'svelte/store'

import type { TaskFormat } from 'Settings'
import type { Unsubscriber } from 'svelte/motion'
import { DESERIALIZERS } from 'serializer'

export type TaskItem = {
    path: string
    text: string
    fileName: string
    name: string
    status: string
    blockLink: string
    checked: boolean
    done: string
    due: string
    created: string
    cancelled: string
    scheduled: string
    start: string
    description: string
    priority: string
    recurrence: string
    expected: number
    actual: number
    tags: string[]
    line: number
    fromQuery?: boolean // Flag to indicate task came from a query
}

export type TaskQuery = {
    source: string
    filters: string[]
    startLine: number
    endLine: number
}

export type TaskStore = {
    list: TaskItem[]
}

export default class Tasks implements Readable<TaskStore> {
    private plugin: PomodoroTimerPlugin

    private _store: Writable<TaskStore>

    public subscribe

    private unsubscribers: Unsubscriber[] = []

    private state: TaskStore = {
        list: [],
    }

    public static getDeserializer(format: TaskFormat) {
        return DESERIALIZERS[format]
    }

    constructor(plugin: PomodoroTimerPlugin) {
        this.plugin = plugin

        this._store = writable(this.state)

        this.unsubscribers.push(
            this._store.subscribe((state) => {
                this.state = state
            }),
        )

        this.unsubscribers.push(
            derived(this.plugin.tracker!, ($tracker) => {
                return $tracker.file?.path
            }).subscribe(() => {
                let file = this.plugin.tracker?.file
                if (file) {
                    this.loadFileTasks(file)
                } else {
                    this.clearTasks()
                }
            }),
        )

        this.subscribe = this._store.subscribe

        this.plugin.registerEvent(
            plugin.app.metadataCache.on(
                'changed',
                (file: TFile, content: string, cache: CachedMetadata) => {
                    if (
                        file.extension === 'md' &&
                        file == this.plugin.tracker!.file
                    ) {
                        this.updateTasks(file, content, cache)
                    }
                },
            ),
        )
    }

    private async updateTasks(file: TFile, content: string, cache: CachedMetadata | null) {
        // Extract tasks directly from the file
        let fileTasks = resolveTasks(
            this.plugin.getSettings().taskFormat,
            file,
            content,
            cache,
        )
        
        console.log("Direct file tasks:", fileTasks.length);
        
        // Extract and process task queries
        const queries = extractTaskQueries(content)
        console.log("Found task queries:", queries.length);
        
        const queryTasks = await this.processTaskQueries(queries)
        console.log("Tasks from queries:", queryTasks.length);
        
        // Combine file tasks and query tasks, avoiding duplicates
        const allTasks = this.mergeTasks(fileTasks, queryTasks)
        console.log("Total tasks after merge:", allTasks.length);
        
        // Update the store
        this._store.update((state) => {
            state.list = allTasks
            return state
        })

        // Sync active task
        if (this.plugin.tracker?.task?.blockLink) {
            let task = allTasks.find(
                (item) =>
                    item.blockLink &&
                    item.blockLink === this.plugin.tracker?.task?.blockLink,
            )
            if (task) {
                this.plugin.tracker.sync(task)
            }
        }
    }

    private mergeTasks(fileTasks: TaskItem[], queryTasks: TaskItem[]): TaskItem[] {
        // Use Map to deduplicate tasks by blockLink
        const taskMap = new Map<string, TaskItem>()
        
        // Add file tasks first
        for (const task of fileTasks) {
            if (task.blockLink) {
                taskMap.set(task.blockLink, task)
            } else {
                // For tasks without blockLink, use combination of path and line
                taskMap.set(`${task.path}-${task.line}`, task)
            }
        }
        
        // Add query tasks, only if they don't already exist
        for (const task of queryTasks) {
            if (task.blockLink && !taskMap.has(task.blockLink)) {
                taskMap.set(task.blockLink, task)
            } else if (!taskMap.has(`${task.path}-${task.line}`)) {
                taskMap.set(`${task.path}-${task.line}`, task)
            }
        }
        
        return Array.from(taskMap.values())
    }

    private async processTaskQueries(queries: TaskQuery[]): Promise<TaskItem[]> {
        const allQueryTasks: TaskItem[] = []
        
        for (const query of queries) {
            const tasks = await this.executeTaskQuery(query)
            allQueryTasks.push(...tasks)
        }
        
        return allQueryTasks
    }

    private async executeTaskQuery(query: TaskQuery): Promise<TaskItem[]> {
        // Get all markdown files in vault
        const files = this.plugin.app.vault.getMarkdownFiles()
        const taskFormat = this.plugin.getSettings().taskFormat
        const queryTasks: TaskItem[] = []
        
        // Parse query filters
        const filters = this.parseQueryFilters(query.filters)
        
        // Process each file
        for (const file of files) {
            // Skip current file to avoid duplicates with direct tasks
            if (file === this.plugin.tracker?.file) continue
            
            // Check path filter first to avoid unnecessary file reads
            if (filters.paths.length > 0 && !this.fileMatchesPathFilter(file.path, filters.paths)) {
                continue
            }
            
            // Read file content and get metadata
            const content = await this.plugin.app.vault.cachedRead(file)
            const metadata = this.plugin.app.metadataCache.getFileCache(file)
            
            // Get tasks from file
            const fileTasks = resolveTasks(taskFormat, file, content, metadata)
            
            // Filter tasks according to query criteria
            const matchingTasks = fileTasks.filter(task => this.taskMatchesQuery(task, filters))
            
            // Mark tasks as coming from a query and add to results
            matchingTasks.forEach(task => {
                task.fromQuery = true
                queryTasks.push(task)
            })
        }
        
        // Sort according to query sort options
        this.sortTasksByQuery(queryTasks, filters.sort)
        
        return queryTasks
    }

    private parseQueryFilters(filterLines: string[]): any {
        // Parse query filters to structured format
        const filters: any = {
            status: [],
            notDone: false,
            paths: [],
            excludePaths: [],
            headingExcludes: [],
            headingIncludes: [],
            sort: []
        }
        
        for (const line of filterLines) {
            const trimmedLine = line.trim().toLowerCase()
            
            // Process each filter type
            if (trimmedLine.startsWith('status.name includes')) {
                filters.status.push(trimmedLine.replace('status.name includes', '').trim())
            } else if (trimmedLine === 'not done') {
                filters.notDone = true
            } else if (trimmedLine.startsWith('heading does not include')) {
                filters.headingExcludes.push(trimmedLine.replace('heading does not include', '').trim())
            } else if (trimmedLine.startsWith('path includes')) {
                filters.paths.push(trimmedLine.replace('path includes', '').trim())
            } else if (trimmedLine.startsWith('sort by')) {
                filters.sort = trimmedLine.replace('sort by', '').split(',').map((s: string) => s.trim())
            }
            // Add more filter parsing as needed
        }
        
        return filters
    }

    private taskMatchesQuery(task: TaskItem, filters: any): boolean {
        // Check if task matches all query criteria
        
        // Check status
        if (filters.status.length > 0 && !filters.status.some((s: string) => task.status.includes(s))) {
            return false
        }
        
        // Check not done
        if (filters.notDone && task.checked) {
            return false
        }
        
        // Add more filter matching logic as needed
        
        return true
    }

    private fileMatchesPathFilter(filePath: string, pathFilters: string[]): boolean {
        if (pathFilters.length === 0) return true
        return pathFilters.some(filter => filePath.includes(filter))
    }

    private sortTasksByQuery(tasks: TaskItem[], sortOptions: string[]): void {
        if (sortOptions.length === 0) return
        
        tasks.sort((a, b) => {
            for (const option of sortOptions) {
                const trimmedOption = option.trim()
                
                if (trimmedOption === 'priority') {
                    if (a.priority !== b.priority) {
                        // Sort by priority (higher first)
                        const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2, '': 3 }
                        return priorityOrder[a.priority] - priorityOrder[b.priority]
                    }
                } else if (trimmedOption === 'due') {
                    if (a.due && b.due) {
                        return a.due.localeCompare(b.due)
                    } else if (a.due) {
                        return -1
                    } else if (b.due) {
                        return 1
                    }
                }
                // Add more sort options as needed
            }
            return 0
        })
    }

    public async loadFileTasks(file: TFile) {
        if (file.extension == 'md') {
            const content = await this.plugin.app.vault.cachedRead(file)
            const cache = this.plugin.app.metadataCache.getFileCache(file)
            await this.updateTasks(file, content, cache)
        } else {
            this._store.update(() => ({
                list: [],
            }))
        }
    }

    public clearTasks() {
        this._store.update(() => ({
            list: [],
        }))
    }

    public destroy() {
        for (let unsub of this.unsubscribers) {
            unsub()
        }
    }
}

// Extract task queries from content
export function extractTaskQueries(content: string): TaskQuery[] {
    const queries: TaskQuery[] = []
    const lines = content.split('\n')
    
    console.log("Extracting task queries from content with", lines.length, "lines");
    
    // Check for task query code blocks
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        
        // Check for start of tasks query block
        if (line === '```tasks' || line === '> ```tasks') {
            console.log("Found task query start at line", i, ":", line);
            const queryStart = i
            const filters: string[] = []
            let j = i + 1
            
            // Collect all filter lines
            while (j < lines.length) {
                const currentLine = lines[j].trim()
                
                // Check for end of query block
                if (currentLine === '```' || currentLine === '> ```') {
                    console.log("Found task query end at line", j);
                    break
                }
                
                // Skip empty lines and add non-empty lines as filters
                if (currentLine && !currentLine.startsWith('>')) {
                    console.log("Adding filter:", currentLine);
                    filters.push(currentLine)
                } else if (currentLine.startsWith('> ')) {
                    // Handle blockquote format
                    const withoutPrefix = currentLine.substring(2).trim()
                    if (withoutPrefix) {
                        console.log("Adding blockquote filter:", withoutPrefix);
                        filters.push(withoutPrefix)
                    }
                }
                
                j++
            }
            
            // Save the query if we found the end marker
            if (j < lines.length) {
                console.log("Adding query with", filters.length, "filters");
                queries.push({
                    source: lines.slice(i, j + 1).join('\n'),
                    filters,
                    startLine: queryStart,
                    endLine: j
                })
                
                // Move past this query
                i = j
            }
        }
    }
    
    console.log("Found", queries.length, "task queries");
    return queries;
}

export function resolveTasks(
    format: TaskFormat,
    file: TFile,
    content: string,
    metadata: CachedMetadata | null,
): TaskItem[] {
    if (!content || !metadata) {
        return []
    }

    let cache: Record<number, TaskItem> = {}
    const lines = content.split('\n')
    for (let rawElement of metadata.listItems || []) {
        if (rawElement.task) {
            let lineNr = rawElement.position.start.line
            let line = lines[lineNr]

            const components = extractTaskComponents(line)
            if (!components) {
                continue
            }
            let detail = DESERIALIZERS[format].deserialize(components.body)

            let [actual, expected] = detail.pomodoros.split('/')

            const dateformat = 'YYYY-MM-DD'
            let item: TaskItem = {
                text: line,
                path: file.path,
                fileName: file.name,
                name: detail.description,
                status: components.status,
                blockLink: components.blockLink,
                checked: rawElement.task != '' && rawElement.task != ' ',
                description: detail.description,
                done: detail.doneDate?.format(dateformat) ?? '',
                due: detail.dueDate?.format(dateformat) ?? '',
                created: detail.createdDate?.format(dateformat) ?? '',
                cancelled: detail.cancelledDate?.format(dateformat) ?? '',
                scheduled: detail.scheduledDate?.format(dateformat) ?? '',
                start: detail.startDate?.format(dateformat) ?? '',
                priority: detail.priority,
                recurrence: detail.recurrenceRule,
                expected: expected ? parseInt(expected) : 0,
                actual: actual === '' ? 0 : parseInt(actual),
                tags: detail.tags,
                line: lineNr,
            }

            cache[lineNr] = item
        }
    }

    return Object.values(cache)
}
