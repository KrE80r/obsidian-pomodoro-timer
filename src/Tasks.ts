import PomodoroTimerPlugin from 'main'
import { type CachedMetadata, type TFile, type App } from 'obsidian'
import { extractTaskComponents } from 'utils'
import { writable, derived, type Readable, type Writable } from 'svelte/store'

import type { TaskFormat } from 'Settings'
import type { Unsubscriber } from 'svelte/motion'
import { DESERIALIZERS } from 'serializer'

interface TasksPluginTask {
    text: string;
    path: string;
    description: string;
    status: string;
    checked: boolean;
    line: number;
}

interface InternalApi {
    getInternalApi: () => {
        search: (query: string) => Promise<TasksPluginTask[]>;
    };
}

interface TasksPlugin {
    InternalApi: InternalApi;
}

function isTasksPlugin(plugin: unknown): plugin is TasksPlugin {
    const p = plugin as any;
    return Boolean(
        p &&
        typeof p === 'object' &&
        p.InternalApi?.getInternalApi &&
        typeof p.InternalApi.getInternalApi().search === 'function'
    );
}

interface DataviewTask {
    text: string;
    path: string;
    status: string;
    completed: boolean;
    completion: Date;
    due?: Date;
    created?: Date;
    scheduled?: Date;
    priority?: string;
    tags: string[];
    line: number;
    link: { path: string };
    header?: { subpath: string };
    position: { start: { line: number; col: number; offset: number } };
}

interface DataviewPage {
    file: {
        path: string;
        tasks: DataviewTask[];
    };
}

interface DataviewAPI {
    query: (source: string) => Promise<any>;
}

interface DataviewPlugin {
    api: DataviewAPI;
}

function isDataviewPlugin(plugin: unknown): plugin is DataviewPlugin {
    const p = plugin as any;
    return Boolean(
        p?.api?.query &&
        typeof p.api.query === 'function'
    );
}

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
    heading?: string
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
                        this._store.update((state) => {
                            state.list = tasks
                            return state
                        })

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
                },
            ),
        )
    }

    private convertToTaskItem(task: any, file: TFile): TaskItem {
        return {
            text: task.text || '',
            path: task.path || file.path,
            fileName: task.path ? task.path.split('/').pop() || '' : file.name,
            name: task.text || '',
            status: task.status || '',
            blockLink: task.link || '',
            checked: task.completed || false,
            description: task.text || '',
            done: '',
            due: task.due?.toString() || '',
            created: task.created?.toString() || '',
            cancelled: '',
            scheduled: task.scheduled?.toString() || '',
            start: '',
            priority: task.priority || '',
            recurrence: '',
            expected: 0,
            actual: 0,
            tags: task.tags || [],
            line: task.line || 0,
            heading: task.header || '',
        };
    }

    public loadFileTasks(file: TFile) {
        if (file.extension == 'md') {
            this.plugin.app.vault.cachedRead(file).then(async (c) => {
                const query = this.plugin.getSettings().taskQuery?.trim();
                
                if (query) {
                    const dataviewPlugin = this.plugin.app.plugins.plugins['dataview'] as any;
                    console.log('Dataview plugin found:', dataviewPlugin);

                    if (dataviewPlugin?.api) {
                        let lastTasks: any[] = [];
                        
                        // Try up to 3 times with a delay
                        for (let attempt = 0; attempt < 3; attempt++) {
                            try {
                                if (attempt > 0) {
                                    await new Promise(resolve => setTimeout(resolve, 500));
                                }

                                // Check if Dataview is still indexing
                                if (dataviewPlugin.index && !dataviewPlugin.index.initialized) {
                                    console.log('Waiting for Dataview to finish indexing...');
                                    await new Promise(resolve => setTimeout(resolve, 1000));
                                    continue;
                                }

                                const dql = query.toUpperCase().startsWith('TASK') ? 
                                    query : 
                                    `TASK ${query}`;
                                console.log(`Executing Dataview query (attempt ${attempt + 1}):`, dql);
                                
                                const result = await dataviewPlugin.api.query(dql);
                                console.log('Query result:', result);

                                if (result?.successful) {
                                    // Handle the Dataview task array structure
                                    lastTasks = result.value?.values || [];
                                    console.log('Tasks extracted:', lastTasks);

                                    // Always update with whatever tasks we found, even if empty
                                    const convertedTasks = lastTasks.map((t: any) => ({
                                        text: t.text || '',
                                        path: t.link?.path || file.path,
                                        fileName: t.link?.path ? t.link.path.split('/').pop() || '' : file.name,
                                        name: t.text || '',
                                        status: t.status || '',
                                        blockLink: t.link?.path || '',
                                        checked: t.completed || false,
                                        description: t.text || '',
                                        done: '',
                                        due: t.due?.toString() || '',
                                        created: t.created?.toString() || '',
                                        cancelled: '',
                                        scheduled: t.scheduled?.toString() || '',
                                        start: '',
                                        priority: t.priority || '',
                                        recurrence: '',
                                        expected: 0,
                                        actual: 0,
                                        tags: t.tags || [],
                                        line: t.line || 0,
                                        heading: t.header || '',
                                    }));
                                    
                                    console.log('Converted tasks:', convertedTasks);
                                    
                                    this._store.update(() => ({
                                        list: convertedTasks,
                                    }));
                                    return; // Exit here if query was successful, even if no tasks found
                                }

                                // Only continue retrying if query failed
                                if (attempt < 2) {
                                    console.log('Query failed, retrying...');
                                    continue;
                                }
                            } catch (error) {
                                console.error(`Error executing Dataview query (attempt ${attempt + 1}):`, error);
                                if (attempt === 2) throw error;
                            }
                        }
                    }
                }

                // Only fall back to default behavior if Dataview query wasn't successful
                console.log('Using default task parsing');
                let tasks = resolveTasks(
                    this.plugin.getSettings().taskFormat,
                    file,
                    c,
                    this.plugin.app.metadataCache.getFileCache(file),
                );
                this._store.update(() => ({
                    list: tasks,
                }));
            });
        }
    }

    private convertToDataviewQuery(tasksQuery: string): string {
        const lines = tasksQuery.split('\n').filter(l => l.trim());
        const conditions: string[] = [];

        for (const line of lines) {
            const trimmed = line.trim().toLowerCase();
            
            if (trimmed.includes('path includes')) {
                const path = trimmed.match(/path includes (.+)/i)?.[1];
                if (path) {
                    conditions.push(`contains(file.path, "${path}")`);
                }
            }
            
            if (trimmed.includes('status.name includes')) {
                const status = trimmed.match(/status\.name includes (.+)/i)?.[1];
                if (status) {
                    conditions.push(`contains(task.status, "${status}")`);
                }
            }

            if (trimmed === 'not done') {
                conditions.push('!task.completed');
            }
        }

        // Return a DQL query
        return conditions.length > 0 ? conditions.join(' and ') : 'true';
    }

    private convertDataviewToTaskItem(task: DataviewTask, file: TFile): TaskItem {
        return {
            text: task.text || '',
            path: task.path || file.path,
            fileName: task.path ? task.path.split('/').pop() || '' : file.name,
            name: task.text || '',
            status: task.status || '',
            blockLink: task.link?.path || '',
            checked: task.completed || false,
            description: task.text || '',
            done: task.completion?.toISOString().split('T')[0] || '',
            due: task.due?.toISOString().split('T')[0] || '',
            created: task.created?.toISOString().split('T')[0] || '',
            cancelled: '',
            scheduled: task.scheduled?.toISOString().split('T')[0] || '',
            start: '',
            priority: task.priority || '',
            recurrence: '',
            expected: 0,
            actual: 0,
            tags: task.tags || [],
            line: task.line || task.position?.start?.line || 0,
            heading: task.header?.subpath || '',
        };
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
    
    // Get headings map
    const headingsMap = new Map<number, string>();
    if (metadata.headings) {
        for (const heading of metadata.headings) {
            // All lines under this heading until the next heading
            for (let i = heading.position.start.line; i < content.split('\n').length; i++) {
                headingsMap.set(i, heading.heading);
                if (metadata.headings.find(h => h.position.start.line === i + 1)) {
                    break;
                }
            }
        }
    }

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
                heading: headingsMap.get(lineNr),
            }

            cache[lineNr] = item
        }
    }

    return Object.values(cache)
}
