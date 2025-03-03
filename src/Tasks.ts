import PomodoroTimerPlugin from 'main'
import type { CachedMetadata, TFile, App } from 'obsidian'
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
        if (file.extension == 'md') {
            this.plugin.app.vault.cachedRead(file).then((c) => {
                let tasks = resolveTasks(
                    this.plugin.getSettings().taskFormat,
                    file,
                    c,
                    this.plugin.app.metadataCache.getFileCache(file),
                )
                
                // Also load queried tasks if enabled
                if (this.plugin.getSettings().includeQueriedTasks) {
                    this.loadQueriedTasks(file).then(queriedTasks => {
                        this._store.update(() => ({
                            list: [...tasks, ...queriedTasks],
                        }));
                    });
                } else {
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
        // Check if Tasks plugin exists
        const tasksPlugin = this.plugin.app.plugins.plugins['obsidian-tasks-plugin'];
        if (!tasksPlugin) {
            return [];
        }

        try {
            // Get content and parse for task queries
            const content = await this.plugin.app.vault.cachedRead(file);
            const queriedTasks: TaskItem[] = [];
            
            // Look for task query code blocks in the content
            const queryBlocks = content.match(/```tasks\n([\s\S]*?)```/g);
            if (!queryBlocks || queryBlocks.length === 0) {
                return [];
            }
            
            // For each query block, try to get tasks from the Tasks plugin
            for (const queryBlock of queryBlocks) {
                // Get tasks from the Tasks plugin's cache if possible
                // Using a more defensive approach to access potentially undefined properties
                if (tasksPlugin.cache && 
                    typeof tasksPlugin.cache === 'object' && 
                    'getTasks' in tasksPlugin.cache && 
                    typeof tasksPlugin.cache.getTasks === 'function') {
                    
                    const tasks = tasksPlugin.cache.getTasks();
                    
                    // Apply query filters (simplified version - in a real implementation 
                    // you'd need to parse and apply the query conditions)
                    for (const task of tasks) {
                        // Convert to our TaskItem format
                        if (task.file && task.file.path && task.line !== undefined) {
                            const taskFile = this.plugin.app.vault.getAbstractFileByPath(task.file.path);
                            if (taskFile instanceof TFile) {
                                const fileContent = await this.plugin.app.vault.cachedRead(taskFile);
                                const lines = fileContent.split('\n');
                                if (task.line < lines.length) {
                                    const line = lines[task.line];
                                    const components = extractTaskComponents(line);
                                    if (components) {
                                        const detail = DESERIALIZERS[this.plugin.getSettings().taskFormat].deserialize(components.body);
                                        const [actual, expected] = detail.pomodoros.split('/');
                                        const dateformat = 'YYYY-MM-DD';
                                        
                                        queriedTasks.push({
                                            text: line,
                                            path: task.file.path,
                                            fileName: taskFile.name,
                                            name: detail.description,
                                            status: components.status,
                                            blockLink: components.blockLink,
                                            checked: task.checked,
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
                                            line: task.line,
                                            source: 'query'
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
            
            return queriedTasks;
        } catch (error) {
            console.error('Error loading queried tasks:', error);
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
