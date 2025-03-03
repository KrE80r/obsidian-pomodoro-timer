import PomodoroTimerPlugin from 'main'
import type { CachedMetadata, App } from 'obsidian'
import { TFile } from 'obsidian'
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
    source: 'direct' | 'query'
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
                        let tasks = resolveTasks(
                            this.plugin.getSettings().taskFormat,
                            file,
                            content,
                            cache,
                        )
                        
                        // Also load queried tasks if enabled
                        if (this.plugin.getSettings().includeQueriedTasks) {
                            this.loadQueriedTasks(file).then(queriedTasks => {
                                this._store.update((state) => {
                                    state.list = [...tasks, ...queriedTasks];
                                    return state;
                                });
                                
                                // sync active task
                                if (this.plugin.tracker?.task?.blockLink) {
                                    let task = [...tasks, ...queriedTasks].find(
                                        (item) =>
                                            item.blockLink &&
                                            item.blockLink ===
                                                this.plugin.tracker?.task?.blockLink,
                                    )
                                    if (task) {
                                        this.plugin.tracker.sync(task)
                                    }
                                }
                            });
                        } else {
                            this._store.update((state) => {
                                state.list = tasks;
                                return state;
                            });
                            
                            // sync active task
                            if (this.plugin.tracker?.task?.blockLink) {
                                let task = tasks.find(
                                    (item) =>
                                        item.blockLink &&
                                        item.blockLink ===
                                            this.plugin.tracker?.task?.blockLink,
                                )
                                if (task) {
                                    this.plugin.tracker.sync(task)
                                }
                            }
                        }
                    }
                },
            ),
        )
    }

    public loadFileTasks(file: TFile) {
        console.log("Pomodoro Timer: loadFileTasks called for", file.path);
        console.log("Pomodoro Timer: includeQueriedTasks setting is", this.plugin.getSettings().includeQueriedTasks);
        
        if (file.extension == 'md') {
            this.plugin.app.vault.cachedRead(file).then((c) => {
                let tasks = resolveTasks(
                    this.plugin.getSettings().taskFormat,
                    file,
                    c,
                    this.plugin.app.metadataCache.getFileCache(file),
                )
                
                console.log("Pomodoro Timer: Loaded", tasks.length, "direct tasks from file");
                
                // Also load queried tasks if enabled
                if (this.plugin.getSettings().includeQueriedTasks) {
                    console.log("Pomodoro Timer: Loading queried tasks (setting enabled)");
                    this.loadQueriedTasks(file).then(queriedTasks => {
                        console.log("Pomodoro Timer: Loaded", queriedTasks.length, "queried tasks");
                        console.log("Pomodoro Timer: Sample queried task:", queriedTasks.length > 0 ? queriedTasks[0] : "none");
                        
                        this._store.update(() => {
                            const allTasks = [...tasks, ...queriedTasks];
                            console.log("Pomodoro Timer: Setting task store with", allTasks.length, "total tasks");
                            return {
                                list: allTasks,
                            };
                        });
                    });
                } else {
                    console.log("Pomodoro Timer: Skipping queried tasks (setting disabled)");
                    this._store.update(() => ({
                        list: tasks,
                    }));
                }
            })
        } else {
            this._store.update(() => ({
                file,
                list: [],
            }))
        }
    }

    /**
     * Load tasks from queries in the current file
     */
    private async loadQueriedTasks(file: TFile): Promise<TaskItem[]> {
        console.log("Pomodoro Timer: loadQueriedTasks called");
        console.log("Pomodoro Timer: includeQueriedTasks setting is", this.plugin.getSettings().includeQueriedTasks);
        
        // Check if Tasks plugin exists
        const tasksPlugin = this.plugin.app.plugins.plugins['obsidian-tasks-plugin'] as any;
        if (!tasksPlugin) {
            console.log("Pomodoro Timer: Tasks plugin not found");
            return [];
        }

        try {
            // Get content and parse for task queries
            const content = await this.plugin.app.vault.cachedRead(file);
            const queriedTasks: TaskItem[] = [];
            
            // Improved matching for task query code blocks - support multiple formats
            // These include ```tasks, ```task, ```dataview task, and {{#tasks}} templates
            const queryRegexes = [
                /```tasks[\s\S]*?```/g,                  // Basic ```tasks block
                /```task[\s\S]*?```/g,                   // Basic ```task block
                /```dataview task[\s\S]*?```/g,          // Dataview task format
                /\{\{#tasks[\s\S]*?\}\}/g                // Templates format
            ];
            
            let queryBlocks: string[] = [];
            queryRegexes.forEach(regex => {
                const matches = content.match(regex);
                if (matches) {
                    queryBlocks = queryBlocks.concat(matches);
                }
            });
                               
            if (queryBlocks.length === 0) {
                console.log("Pomodoro Timer: No task query blocks found in", file.path);
                return [];
            }
            
            console.log("Pomodoro Timer: Found", queryBlocks.length, "task query blocks in", file.path);
            
            // First try the Tasks plugin API - this is the most reliable method
            let allTasks: any[] = [];
            
            // Method 1: Try the official API - most recent versions
            if (tasksPlugin.api && typeof tasksPlugin.api.getTasks === 'function') {
                allTasks = await tasksPlugin.api.getTasks();
                console.log("Pomodoro Timer: Got tasks via Tasks API:", allTasks.length);
            }
            // Method 2: Try accessing via cache.getTasks()
            else if (tasksPlugin.cache && 
                typeof tasksPlugin.cache.getTasks === 'function') {
                allTasks = tasksPlugin.cache.getTasks();
                console.log("Pomodoro Timer: Got tasks via cache.getTasks():", allTasks.length);
            } 
            // Method 3: Try accessing via taskCache.values
            else if (tasksPlugin.taskCache && 
                     tasksPlugin.taskCache.values && 
                     typeof tasksPlugin.taskCache.values === 'function') {
                allTasks = Array.from(tasksPlugin.taskCache.values());
                console.log("Pomodoro Timer: Got tasks via taskCache.values:", allTasks.length);
            }
            // Method 4: Try the data object
            else if (tasksPlugin.data && 
                     tasksPlugin.data.tasks && 
                     Array.isArray(tasksPlugin.data.tasks)) {
                allTasks = tasksPlugin.data.tasks;
                console.log("Pomodoro Timer: Got tasks via data.tasks:", allTasks.length);
            } 
            
            if (allTasks.length === 0) {
                console.log("Pomodoro Timer: No tasks found in Tasks plugin");
                
                // Debug what's available in the plugin
                console.log("Tasks plugin structure:", Object.keys(tasksPlugin));
                
                // As a last resort, try to find any property that might contain tasks
                for (const key of Object.keys(tasksPlugin)) {
                    const value = (tasksPlugin as any)[key];
                    if (Array.isArray(value) && value.length > 0 && value[0] && 
                        (value[0].text || value[0].description)) {
                        console.log(`Found potential tasks array in property: ${key}`, value.length);
                        allTasks = value;
                        break;
                    }
                }
                
                if (allTasks.length === 0) {
                    return [];
                }
            }
            
            // Process all tasks - no need to process per query block as we're not filtering by query yet
            for (const task of allTasks) {
                try {
                    // Skip if task is already completed and not in today's file
                    if (task.checked && task.file?.path !== file.path) {
                        continue;
                    }
                    
                    // Extract necessary information with defensive programming for different task formats
                    const filePath = task.file?.path || task.filePath || task.path;
                    const lineNumber = task.line || task.position?.start?.line || task.lineNumber || 0;
                    
                    if (!filePath) {
                        console.log("Skipping task with no file path:", task);
                        continue;
                    }
                    
                    const taskFile = this.plugin.app.vault.getAbstractFileByPath(filePath);
                    if (!(taskFile instanceof TFile)) {
                        console.log("Skipping task from file that doesn't exist:", filePath);
                        continue;
                    }
                    
                    // Skip tasks from the current file - they're already included directly
                    if (taskFile.path === file.path) {
                        console.log("Skipping task from current file:", taskFile.path);
                        continue;
                    }
                    
                    const fileContent = await this.plugin.app.vault.cachedRead(taskFile);
                    const lines = fileContent.split('\n');
                    
                    if (lineNumber >= lines.length) {
                        console.log("Skipping task with invalid line number:", lineNumber, "in file:", filePath);
                        continue;
                    }
                    
                    const line = lines[lineNumber];
                    const components = extractTaskComponents(line);
                    
                    if (!components) {
                        console.log("Skipping task with no components:", line);
                        continue;
                    }
                    
                    const detail = DESERIALIZERS[this.plugin.getSettings().taskFormat].deserialize(components.body);
                    const [actual, expected] = (detail.pomodoros || "0/0").split('/');
                    const dateformat = 'YYYY-MM-DD';
                    
                    const taskDescription = detail.description || task.description || components.body || task.text;
                    if (!taskDescription) {
                        console.log("Skipping task with no description");
                        continue;
                    }
                    
                    // Create the TaskItem
                    queriedTasks.push({
                        text: line,
                        path: filePath,
                        fileName: taskFile.name,
                        name: taskDescription,
                        status: components.status,
                        blockLink: components.blockLink,
                        checked: task.checked || (components.status !== ' '),
                        description: taskDescription,
                        done: detail.doneDate?.format(dateformat) ?? '',
                        due: detail.dueDate?.format(dateformat) ?? task.due ?? '',
                        created: detail.createdDate?.format(dateformat) ?? '',
                        cancelled: detail.cancelledDate?.format(dateformat) ?? '',
                        scheduled: detail.scheduledDate?.format(dateformat) ?? task.scheduled ?? '',
                        start: detail.startDate?.format(dateformat) ?? task.start ?? '',
                        priority: detail.priority || task.priority || '',
                        recurrence: detail.recurrenceRule || task.recurrence || '',
                        expected: expected ? parseInt(expected) : 0,
                        actual: actual === '' ? 0 : parseInt(actual),
                        tags: detail.tags || task.tags || [],
                        line: lineNumber,
                        source: 'query'
                    });
                } catch (err) {
                    console.error("Pomodoro Timer: Error processing task:", err);
                }
            }
            
            console.log("Pomodoro Timer: Added", queriedTasks.length, "queried tasks");
            return queriedTasks;
        } catch (error) {
            console.error("Pomodoro Timer: Error loading queried tasks:", error);
            return [];
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
                source: 'direct'
            }

            cache[lineNr] = item
        }
    }

    return Object.values(cache)
}
