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
        
        this.setupSubscriptions();
        this.setupFileChangeHandler();
        
        this.subscribe = this._store.subscribe
    }

    private setupSubscriptions() {
        this.unsubscribers.push(
            this._store.subscribe((state) => {
                this.state = state
            }),
            derived(this.plugin.tracker!, ($tracker) => $tracker.file?.path)
                .subscribe(() => {
                    const file = this.plugin.tracker?.file
                    file ? this.loadFileTasks(file) : this.clearTasks()
                })
        );
    }

    private setupFileChangeHandler() {
        this.plugin.registerEvent(
            this.plugin.app.metadataCache.on(
                'changed',
                (file: TFile, content: string, cache: CachedMetadata) => {
                    if (file.extension !== 'md' || file !== this.plugin.tracker?.file) return;
                    
                    const tasks = resolveTasks(
                        this.plugin.getSettings().taskFormat,
                        file,
                        content,
                        cache,
                    );
                    
                    this._store.update(state => ({ ...state, list: tasks }));
                    this.syncActiveTask(tasks);
                }
            )
        );
    }

    private syncActiveTask(tasks: TaskItem[]) {
        if (!this.plugin.tracker?.task?.blockLink) return;
        
        const task = tasks.find(item => 
            item.blockLink && item.blockLink === this.plugin.tracker?.task?.blockLink
        );
        
        if (task) {
            this.plugin.tracker.sync(task);
        }
    }

    public loadFileTasks(file: TFile) {
        if (file.extension !== 'md') return;

        this.plugin.app.vault.cachedRead(file).then(async (content) => {
            const tasks = await this.getTasksFromDataview(file) || 
                         this.getTasksFromFile(file, content);
            
            this._store.update(() => ({ list: tasks }));
        });
    }

    private async getTasksFromDataview(file: TFile): Promise<TaskItem[] | null> {
        const query = this.plugin.getSettings().taskQuery?.trim();
        if (!query) return null;

        const dataviewPlugin = this.plugin.app.plugins.plugins['dataview'] as any;
        if (!dataviewPlugin?.api) return null;

        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                if (attempt > 0) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }

                if (dataviewPlugin.index && !dataviewPlugin.index.initialized) {
                    console.log('Waiting for Dataview to finish indexing...');
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }

                // Use query directly from settings
                console.log(`Executing Dataview query (attempt ${attempt + 1}):`, query);
                const result = await dataviewPlugin.api.query(query);
                console.log('Query result:', result);

                if (result?.successful) {
                    const tasks = result.value?.values || [];
                    console.log('Tasks found:', tasks.length);
                    return tasks.map((t: DataviewTask) => this.convertToTaskItem(t, file));
                }

                if (attempt < 2) {
                    console.log('Query failed, retrying...');
                    continue;
                }
            } catch (error) {
                console.error(`Dataview query attempt ${attempt + 1} failed:`, error);
                if (attempt === 2) throw error;
            }
        }

        return null;
    }

    private getTasksFromFile(file: TFile, content: string): TaskItem[] {
        console.log('Using default task parsing');
        return resolveTasks(
            this.plugin.getSettings().taskFormat,
            file,
            content,
            this.plugin.app.metadataCache.getFileCache(file),
        );
    }

    private convertToTaskItem(task: DataviewTask, file: TFile): TaskItem {
        const fileName = task.link?.path ? 
            task.link.path.split('/').pop() || '' : 
            file.name;
            
        return {
            text: task.text || '',
            path: task.link?.path || file.path,
            fileName,
            name: task.text || '',
            status: task.status || '',
            blockLink: task.link?.path || '',
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

interface DataviewTask {
    text: string;
    status: string;
    completed: boolean;
    due?: Date;
    created?: Date;
    scheduled?: Date;
    priority?: string;
    tags: string[];
    line: number;
    link: { path: string };
    header?: { subpath: string };
}
