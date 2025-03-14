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
        if (!this.plugin.tracker?.task) return;
        
        // If no tasks are available, try to reload them first
        if (!tasks || tasks.length === 0) {
            console.log('No tasks available for sync, attempting to reload tasks first');
            // First check if we have a file to work with
            const file = this.plugin.tracker?.file;
            if (!file) {
                console.warn('Cannot reload tasks: No active file in tracker');
                return;
            }
            
            // Force reload tasks from Dataview
            this.getTasksFromDataview(file).then(reloadedTasks => {
                if (reloadedTasks && reloadedTasks.length > 0) {
                    console.log(`Successfully reloaded ${reloadedTasks.length} tasks from Dataview`);
                    // Update the task store
                    this._store.update(state => ({ ...state, list: reloadedTasks }));
                    // Now try again with the reloaded tasks
                    this.syncActiveTaskWithTasks(reloadedTasks);
                } else {
                    console.warn('Failed to reload tasks from Dataview, trying direct file parsing');
                    // As a last resort, try parsing tasks directly from the file
                    this.plugin.app.vault.cachedRead(file).then(content => {
                        const cache = this.plugin.app.metadataCache.getFileCache(file);
                        const parsedTasks = resolveTasks(
                            this.plugin.getSettings().taskFormat,
                            file,
                            content,
                            cache
                        );
                        
                        if (parsedTasks && parsedTasks.length > 0) {
                            console.log(`Successfully parsed ${parsedTasks.length} tasks from file`);
                            // Update the task store
                            this._store.update(state => ({ ...state, list: parsedTasks }));
                            // Try syncing again with parsed tasks
                            this.syncActiveTaskWithTasks(parsedTasks);
                        } else {
                            console.error('Failed to load any tasks, cannot update pomodoro count');
                        }
                    }).catch(error => {
                        console.error('Error parsing file for tasks:', error);
                    });
                }
            }).catch(error => {
                console.error('Error reloading tasks from Dataview:', error);
            });
            
            return; // Exit early, sync will be called after reloading if successful
        }
        
        // If we have tasks, proceed with synchronization
        this.syncActiveTaskWithTasks(tasks);
    }
    
    /**
     * Sync the active task with the provided tasks list
     * This is separated from syncActiveTask to allow for recursive calls after reloading tasks
     */
    private syncActiveTaskWithTasks(tasks: TaskItem[]) {
        if (!this.plugin.tracker?.task) return;
        
        // Multiple identification methods for maximum reliability
        const activeTask = this.findTaskByMultipleIdentifiers(tasks);
        
        if (activeTask) {
            console.log('Task found for sync:', {
                text: activeTask.text,
                current_actual: activeTask.actual,
                blockLink: activeTask.blockLink
            });

            // Update the pomodoro count
            const currentCount = activeTask.actual || 0;
            const newCount = currentCount + 1;
            
            // Create updated task with new count
            const updatedTask = this.updateTaskWithPomodoroCount(activeTask, newCount);

            console.log('Updated task for sync:', {
                text: updatedTask.text,
                new_actual: updatedTask.actual,
                blockLink: updatedTask.blockLink
            });

            this.plugin.tracker.sync(updatedTask);
        } else {
            // Additional logging to help diagnose the issue
            console.warn('Could not find task to update pomodoro count', {
                trackerTaskBlockLink: this.plugin.tracker?.task?.blockLink,
                trackerTaskDescription: this.plugin.tracker?.task?.description,
                trackerTaskLine: this.plugin.tracker?.task?.line,
                availableTasks: tasks.length,
                taskBlockLinks: tasks.map(t => t.blockLink).join(', '),
            });
        }
    }

    /**
     * Find a task using multiple identification methods for robustness
     */
    private findTaskByMultipleIdentifiers(tasks: TaskItem[]): TaskItem | undefined {
        const trackerTask = this.plugin.tracker?.task;
        if (!trackerTask) return undefined;
        
        // Method 1: Find by blockLink (most reliable if available)
        if (trackerTask.blockLink) {
            // Normalize block IDs for comparison (handle both formats with and without ^)
            const trackerBlockId = this.normalizeBlockId(trackerTask.blockLink);
            
            const taskByBlockLink = tasks.find(item => {
                if (!item.blockLink) return false;
                const itemBlockId = this.normalizeBlockId(item.blockLink);
                return itemBlockId === trackerBlockId;
            });
            
            if (taskByBlockLink) {
                console.log('Task identified by blockLink', { 
                    trackerBlockId,
                    taskBlockId: this.normalizeBlockId(taskByBlockLink.blockLink)
                });
                return taskByBlockLink;
            }
        }
        
        // Method 2: Find by text content (excluding metadata like dates and block IDs)
        if (trackerTask.description) {
            const normalizedTargetDesc = this.normalizeTaskText(trackerTask.description);
            const taskByDesc = tasks.find(item => {
                const normalizedItemDesc = this.normalizeTaskText(item.description);
                return normalizedTargetDesc === normalizedItemDesc;
            });
            
            if (taskByDesc) {
                console.log('Task identified by description content match');
                return taskByDesc;
            }
        }
        
        // Method 3: Find by line number (as last resort)
        if (trackerTask.line !== undefined) {
            const taskByLine = tasks.find(item => 
                item.line === trackerTask.line
            );
            if (taskByLine) {
                console.log('Task identified by line number', taskByLine.line);
                return taskByLine;
            }
        }
        
        return undefined;
    }
    
    /**
     * Normalize a block ID by removing the caret prefix if present
     * and ensuring consistent format for comparison
     */
    private normalizeBlockId(blockId: string): string {
        // Remove the caret if present
        return blockId.replace(/^\^/, '').trim();
    }
    
    /**
     * Normalize task text for comparison by removing metadata, dates, pomodoro counts, etc.
     */
    private normalizeTaskText(text: string): string {
        return text
            .replace(/\[🍅::\s*\d+(?:\/\d+)?\]/g, '') // Remove pomodoro counts
            .replace(/➕\s+\d{4}-\d{2}-\d{2}/g, '')    // Remove created date
            .replace(/📅\s+\d{4}-\d{2}-\d{2}/g, '')    // Remove due date
            .replace(/⏳\s+\d{4}-\d{2}-\d{2}/g, '')    // Remove scheduled date
            .replace(/✅\s+\d{4}-\d{2}-\d{2}/g, '')    // Remove completed date
            .replace(/\s\^[\w\d-]+/g, '')            // Remove block IDs
            .replace(/\s+#[\w\d/-]+/g, '')           // Remove tags
            .replace(/\s+/g, ' ')                    // Normalize whitespace
            .trim();
    }
    
    /**
     * Update task with a new pomodoro count, handling different formats
     */
    private updateTaskWithPomodoroCount(task: TaskItem, newCount: number): TaskItem {
        // Start with the original task text
        let updatedText = task.text;
        
        // Check for existing pomodoro count with different possible formats
        const pomodoroPatterns = [
            /\[🍅::\s*\d+\]/,          // Standard format [🍅:: 3]
            /🍅\s*\d+/,                // Simple format 🍅 3
            /\[\s*🍅\s*:\s*\d+\s*\]/   // Alternative format [🍅: 3]
        ];
        
        let patternFound = false;
        
        for (const pattern of pomodoroPatterns) {
            if (pattern.test(updatedText)) {
                // Replace existing pomodoro count using the same format that was found
                updatedText = updatedText.replace(pattern, (match) => {
                    // Keep the same format, just update the number
                    if (match.includes('::')) {
                        return `[🍅:: ${newCount}]`;
                    } else if (match.includes(':')) {
                        return `[🍅: ${newCount}]`;
                    } else {
                        return `🍅 ${newCount}`;
                    }
                });
                patternFound = true;
                break;
            }
        }
        
        // If no pomodoro count exists, add it in the standard format before metadata
        if (!patternFound) {
            // Look for common task metadata patterns to insert before
            const metadataPatterns = [
                /\s+➕\s+\d{4}-\d{2}-\d{2}/,  // Created date
                /\s+📅\s+\d{4}-\d{2}-\d{2}/,  // Due date
                /\s+⏳\s+\d{4}-\d{2}-\d{2}/,  // Scheduled date
                /\s+✅\s+\d{4}-\d{2}-\d{2}/,  // Completed date
                /\s+#[\w\d/-]+/,             // Tags
                /\s+\^[\w\d-]+/              // Block ID
            ];
            
            let insertPosition = updatedText.length;
            
            for (const pattern of metadataPatterns) {
                const match = updatedText.match(pattern);
                if (match && match.index !== undefined && match.index < insertPosition) {
                    insertPosition = match.index;
                }
            }
            
            // Insert the pomodoro count at the appropriate position
            if (insertPosition < updatedText.length) {
                updatedText = 
                    updatedText.substring(0, insertPosition) + 
                    ` [🍅:: ${newCount}]` + 
                    updatedText.substring(insertPosition);
            } else {
                // Just append to the end if no metadata found
                updatedText += ` [🍅:: ${newCount}]`;
            }
        }
        
        return {
            ...task,
            text: updatedText,
            actual: newCount,
            expected: Math.max(task.expected || 0, newCount)
        };
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

    /**
     * Ensure tasks are loaded for the current file and then perform an action with them
     * This helps avoid race conditions where tasks aren't loaded when needed
     */
    public ensureTasksLoaded(callback: (tasks: TaskItem[]) => void): void {
        const file = this.plugin.tracker?.file;
        if (!file) {
            console.warn('Cannot ensure tasks are loaded: No active file in tracker');
            return;
        }

        // If we already have tasks for this file, use them
        if (this.state.list && this.state.list.length > 0) {
            console.log(`Using ${this.state.list.length} already loaded tasks`);
            callback(this.state.list);
            return;
        }

        // Otherwise, load tasks from Dataview first
        console.log('No tasks loaded, fetching from Dataview...');
        this.getTasksFromDataview(file).then(tasks => {
            if (tasks && tasks.length > 0) {
                console.log(`Loaded ${tasks.length} tasks from Dataview`);
                // Update the store
                this._store.update(state => ({ ...state, list: tasks }));
                // Call the callback with the loaded tasks
                callback(tasks);
            } else {
                console.warn('Failed to load tasks from Dataview, trying direct file parsing');
                // As a fallback, try parsing the file directly
                this.plugin.app.vault.cachedRead(file).then(content => {
                    const cache = this.plugin.app.metadataCache.getFileCache(file);
                    const parsedTasks = resolveTasks(
                        this.plugin.getSettings().taskFormat,
                        file,
                        content,
                        cache
                    );
                    
                    if (parsedTasks && parsedTasks.length > 0) {
                        console.log(`Parsed ${parsedTasks.length} tasks from file`);
                        // Update the store
                        this._store.update(state => ({ ...state, list: parsedTasks }));
                        // Call the callback with the parsed tasks
                        callback(parsedTasks);
                    } else {
                        console.error('Failed to load any tasks through all available methods');
                    }
                }).catch(error => {
                    console.error('Error parsing file for tasks:', error);
                });
            }
        }).catch(error => {
            console.error('Error loading tasks from Dataview:', error);
        });
    }

    /**
     * Public method to update the pomodoro count for the active task
     * This can be called from the Timer component when a pomodoro completes
     */
    public updateActiveTaskPomodoroCount(): void {
        // First ensure tasks are loaded before attempting to update
        this.ensureTasksLoaded(tasks => {
            this.syncActiveTask(tasks);
        });
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
