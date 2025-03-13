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
            console.log('Before sync - Task:', {
                text: task.text,
                actual: task.actual,
                blockLink: task.blockLink
            });

            // Update the pomodoro count
            const currentCount = task.actual || 0;
            const newCount = currentCount + 1;
            
            // Update the task text with new pomodoro count
            let updatedText = task.text;
            if (task.text.includes('[🍅::')) {
                // Update existing pomodoro count
                updatedText = task.text.replace(/\[🍅::\s*\d+\]/, `[🍅:: ${newCount}]`);
            } else {
                // Add pomodoro count before the date and block ID
                updatedText = task.text.replace(/(\s*➕\s+\d{4}-\d{2}-\d{2})?(\s*\^[\w\d-]+)?$/, 
                    ` [🍅:: ${newCount}]$1$2`);
            }

            const updatedTask = {
                ...task,
                text: updatedText,
                actual: newCount,
                expected: Math.max(task.expected, newCount)
            };

            console.log('After sync - Updated Task:', {
                text: updatedTask.text,
                actual: updatedTask.actual,
                blockLink: updatedTask.blockLink
            });

            this.plugin.tracker.sync(updatedTask);
        }
    }

    public loadFileTasks(file: TFile) {
        if (file.extension !== 'md') return;

        this.plugin.app.vault.cachedRead(file).then(async () => {
            // Only use Dataview query, never fall back to parsing the file
            const tasks = await this.getTasksFromDataview(file);
            
            // Update the task list (even if tasks is null, which clears the list)
            this._store.update(() => ({ list: tasks || [] }));
        });
    }

    private async getTasksFromDataview(file: TFile): Promise<TaskItem[] | null> {
        const query = this.plugin.getSettings().taskQuery?.trim();
        if (!query) {
            console.warn('No Dataview query configured in settings');
            if (this.plugin.app?.workspace) {
                const Notice = this.plugin.app.workspace.containerEl.createEl('div');
                Notice.setText('No Dataview query configured in Pomodoro Timer settings');
                Notice.addClass('notice');
                setTimeout(() => {
                    Notice.remove();
                }, 3000);
            }
            return null;
        }

        const dataviewPlugin = this.plugin.app.plugins.plugins['dataview'] as any;
        if (!dataviewPlugin?.api) {
            console.warn('Dataview plugin not found or API not available');
            if (this.plugin.app?.workspace) {
                const Notice = this.plugin.app.workspace.containerEl.createEl('div');
                Notice.setText('Dataview plugin required for task queries');
                Notice.addClass('notice');
                setTimeout(() => {
                    Notice.remove();
                }, 3000);
            }
            return null;
        }

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
                
                // Show notification about executing query
                if (attempt === 0 && this.plugin.app?.workspace) {
                    const Notice = this.plugin.app.workspace.containerEl.createEl('div');
                    Notice.setText('Executing Dataview query...');
                    Notice.addClass('notice');
                    setTimeout(() => {
                        Notice.remove();
                    }, 1500);
                }
                
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
                } else if (this.plugin.app?.workspace) {
                    // Show error notification on final attempt
                    const Notice = this.plugin.app.workspace.containerEl.createEl('div');
                    Notice.setText('Dataview query failed');
                    Notice.addClass('notice');
                    setTimeout(() => {
                        Notice.remove();
                    }, 3000);
                }
            } catch (error) {
                console.error(`Dataview query attempt ${attempt + 1} failed:`, error);
                if (attempt === 2 && this.plugin.app?.workspace) {
                    const Notice = this.plugin.app.workspace.containerEl.createEl('div');
                    Notice.setText('Error executing Dataview query');
                    Notice.addClass('notice');
                    setTimeout(() => {
                        Notice.remove();
                    }, 3000);
                }
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
        // Extract pomodoro count before cleaning
        const pomodoroMatch = task.text.match(/\[🍅::\s*(\d+)\]/);
        const pomodoroCount = pomodoroMatch ? parseInt(pomodoroMatch[1]) : 0;
            
        // Get the core task text without losing context
        const cleanText = task.text;  // Keep original text to preserve context
        
        // Improved block ID extraction - more robust regex
        // This will find block IDs anywhere in the text, not just at the end
        const blockIdMatch = task.text.match(/\s\^([\w\d-]+)(?:\s|$)/);
        const blockId = blockIdMatch ? blockIdMatch[1] : '';
        
        console.log('DEBUG: Extracted block ID from Dataview task:', blockId);
        console.log('DEBUG: Original task text:', task.text);

        // For display purposes only, not for storage
        const displayText = task.text
            .replace(/\s*\^[\w\d-]+(?:\s|$)/, ' ')  // Remove block ID from display only
            .replace(/\[🍅::\s*\d+(?:\/\d+)?\]/, '') // Remove pomodoro count from display
            .trim();

        const taskItem = {
            text: cleanText,  // Keep original text with all metadata
            path: task.link?.path || file.path,
            fileName: task.link?.path ? task.link.path.split('/').pop() || '' : file.name,
            name: displayText,  // Use cleaned version for display
            status: task.status || '',
            blockLink: blockId ? `^${blockId}` : '', // Add the caret back for consistency
            checked: task.completed || false,
            description: displayText,  // Use cleaned version for display
            done: '',
            due: task.due?.toString() || '',
            created: task.created?.toString() || '',
            cancelled: '',
            scheduled: task.scheduled?.toString() || '',
            start: '',
            priority: task.priority || '',
            recurrence: '',
            expected: pomodoroCount,
            actual: pomodoroCount,
            tags: task.tags || [],
            line: task.line || 0,
            heading: task.header?.subpath || '',
        };

        return taskItem;
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

    /**
     * Reloads tasks based on the user's Dataview query from settings
     * This method can be called from UI elements to refresh the task list
     */
    public async reloadTasks() {
        console.log('Reloading tasks based on Dataview query...');
        const file = this.plugin.tracker?.file;
        
        if (!file) {
            console.warn('No active file to reload tasks from');
            if (this.plugin.app?.workspace) {
                const Notice = this.plugin.app.workspace.containerEl.createEl('div');
                Notice.setText('No active file to reload tasks from');
                Notice.addClass('notice');
                setTimeout(() => {
                    Notice.remove();
                }, 2000);
            }
            return;
        }
        
        // Check if Dataview plugin is available
        const dataviewPlugin = this.plugin.app.plugins.plugins['dataview'] as any;
        if (!dataviewPlugin?.api) {
            console.warn('Dataview plugin not found but required for task queries');
            if (this.plugin.app?.workspace) {
                const Notice = this.plugin.app.workspace.containerEl.createEl('div');
                Notice.setText('Dataview plugin required for task queries');
                Notice.addClass('notice');
                setTimeout(() => {
                    Notice.remove();
                }, 3000);
            }
            return;
        }
        
        // Check if query is configured
        const query = this.plugin.getSettings().taskQuery?.trim();
        if (!query) {
            console.warn('No Dataview query configured in settings');
            if (this.plugin.app?.workspace) {
                const Notice = this.plugin.app.workspace.containerEl.createEl('div');
                Notice.setText('No Dataview query configured in settings');
                Notice.addClass('notice');
                setTimeout(() => {
                    Notice.remove();
                }, 3000);
            }
            return;
        }
        
        // Clear current tasks first
        this._store.update(() => ({ list: [] }));
        
        try {
            // Load tasks with dataview query only (no file parsing fallback)
            await this.loadFileTasks(file);
            
            // Show a success notification
            if (this.plugin.app?.workspace) {
                const Notice = this.plugin.app.workspace.containerEl.createEl('div');
                Notice.setText('Tasks reloaded successfully');
                Notice.addClass('notice');
                setTimeout(() => {
                    Notice.remove();
                }, 2000);
            }
        } catch (error) {
            console.error('Failed to reload tasks:', error);
            if (this.plugin.app?.workspace) {
                const Notice = this.plugin.app.workspace.containerEl.createEl('div');
                Notice.setText('Failed to reload tasks');
                Notice.addClass('notice');
                setTimeout(() => {
                    Notice.remove();
                }, 2000);
            }
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
    link: { 
        path: string;
        subpath?: string;
    };
    header?: { subpath: string };
}
