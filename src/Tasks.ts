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
    source: 'direct' | 'query' | 'dom'
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
                if (this.plugin.getSettings().includeQueriedTasks && this.plugin.isTasksPluginLoaded()) {
                    console.log("Pomodoro Timer: Loading queried tasks (setting enabled)");
                    this.loadQueriedTasks(file).then(queriedTasks => {
                        console.log("Pomodoro Timer: Loaded", queriedTasks.length, "queried tasks");
                        if (queriedTasks.length > 0) {
                            console.log("Pomodoro Timer: Sample queried task:", queriedTasks[0]);
                        }
                        
                        this._store.update(() => {
                            const allTasks = [...tasks, ...queriedTasks];
                            console.log("Pomodoro Timer: Setting task store with", allTasks.length, "total tasks");
                            return {
                                list: allTasks,
                            };
                        });
                    });
                } else {
                    if (!this.plugin.isTasksPluginLoaded()) {
                        console.log("Pomodoro Timer: Tasks plugin not loaded, skipping queried tasks");
                    } else {
                        console.log("Pomodoro Timer: Skipping queried tasks (setting disabled)");
                    }
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
        if (!this.plugin.isTasksPluginLoaded()) {
            console.log("Pomodoro Timer: Tasks plugin not found");
            return [];
        }
        
        const tasksPlugin = this.plugin.app.plugins.plugins['obsidian-tasks-plugin'] as any;

        try {
            // Get content and parse for task queries
            const content = await this.plugin.app.vault.cachedRead(file);
            const queriedTasks: TaskItem[] = [];
            
            // Look for task queries in the content
            // Instead of just finding query blocks, we'll identify the specific query in each block
            // so we can match it with the tasks we find
            const queryBlocks: string[] = [];
            const queryRegexes = [
                /```tasks[\s\S]*?```/g,
                /```task[\s\S]*?```/g,
                /```dataview task[\s\S]*?```/g,
                /\{\{#tasks[\s\S]*?\}\}/g
            ];
            
            queryRegexes.forEach(regex => {
                const matches = content.match(regex);
                if (matches) {
                    queryBlocks.push(...matches);
                }
            });
            
            if (queryBlocks.length === 0) {
                console.log("Pomodoro Timer: No task query blocks found in", file.path);
                return [];
            }
            
            console.log("Pomodoro Timer: Found", queryBlocks.length, "task query blocks in", file.path);
            
            // Wait for Tasks plugin to render its tasks
            const waitForTasksToRender = async (): Promise<boolean> => {
                console.log("Pomodoro Timer: Waiting for Tasks plugin to render tasks...");
                
                // Try up to 5 times with increasing delays
                for (let attempt = 0; attempt < 5; attempt++) {
                    // First, try to get tasks from the plugin
                    let allTasks: any[] = [];
                    
                    // Try the official API first
                    if (tasksPlugin.api && typeof tasksPlugin.api.getTasks === 'function') {
                        allTasks = await tasksPlugin.api.getTasks();
                        console.log(`Pomodoro Timer: Attempt ${attempt + 1} - Got tasks via Tasks API:`, allTasks.length);
                        if (allTasks.length > 0) {
                            return true;
                        }
                    }
                    
                    // Try cache next
                    if (tasksPlugin.cache && typeof tasksPlugin.cache.getTasks === 'function') {
                        allTasks = tasksPlugin.cache.getTasks();
                        console.log(`Pomodoro Timer: Attempt ${attempt + 1} - Got tasks via cache.getTasks():`, allTasks.length);
                        if (allTasks.length > 0) {
                            return true;
                        }
                    }
                    
                    // Look for task containers in the current note's view only
                    const currentLeaf = this.plugin.app.workspace.activeLeaf;
                    if (currentLeaf && currentLeaf.view && currentLeaf.view.containerEl) {
                        const taskContainers = currentLeaf.view.containerEl.querySelectorAll('.tasks-list');
                        if (taskContainers.length > 0) {
                            console.log(`Pomodoro Timer: Found ${taskContainers.length} task containers in current view`);
                            await new Promise(resolve => setTimeout(resolve, 500));
                            return true;
                        }
                    }
                    
                    // Wait longer with each attempt
                    const delay = Math.pow(2, attempt) * 500; // 500ms, 1s, 2s, 4s, 8s
                    console.log(`Pomodoro Timer: No tasks found yet, waiting ${delay}ms before next attempt...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
                
                console.log("Pomodoro Timer: Gave up waiting for Tasks plugin to render");
                return false;
            };
            
            // Wait for tasks to render
            const tasksRendered = await waitForTasksToRender();
            if (!tasksRendered) {
                console.log("Pomodoro Timer: Tasks plugin did not render tasks in time");
            }
            
            // Now try to get the tasks
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
            
            // As a last resort, try to find tasks in the DOM and parse them
            if (allTasks.length === 0) {
                console.log("Pomodoro Timer: No tasks found via plugin APIs, trying DOM extraction");
                
                // Get current active view - we only want tasks from this view
                const currentLeaf = this.plugin.app.workspace.activeLeaf;
                if (!currentLeaf || !currentLeaf.view || !currentLeaf.view.containerEl) {
                    console.log("Pomodoro Timer: Cannot find active view, skipping DOM extraction");
                    return [];
                }
                
                // Look for rendered task blocks only in the current view
                const taskQueryElements = currentLeaf.view.containerEl.querySelectorAll('.tasks-query-result, .tasks-list');
                console.log(`Pomodoro Timer: Found ${taskQueryElements.length} task query result containers in current view`);
                
                // For each query result container, find the task list items
                if (taskQueryElements.length > 0) {
                    Array.from(taskQueryElements).forEach(container => {
                        // Find all task list items within this container
                        const taskElements = container.querySelectorAll('li.task-list-item');
                        console.log(`Pomodoro Timer: Found ${taskElements.length} task elements in container`);
                        
                        Array.from(taskElements).forEach(taskElement => {
                            try {
                                // Extract task details
                                // Different versions of the Tasks plugin might store data differently
                                
                                // Get the text content, cleaning up any extra whitespace
                                const taskText = (taskElement.textContent || '').trim();
                                if (!taskText) {
                                    return; // Skip empty tasks
                                }
                                
                                // Try to get file path and line from data attributes
                                let taskPath = '';
                                let taskLine = 0;
                                
                                // Try different ways to get the source information
                                const dataTaskPath = taskElement.getAttribute('data-task-path') || '';
                                const dataSourceFile = taskElement.getAttribute('data-source-file') || '';
                                const dataLine = taskElement.getAttribute('data-line') || '0';
                                
                                // Determine the most likely file path
                                taskPath = dataTaskPath || dataSourceFile || '';
                                
                                // If we don't have a path but there's a link, try to extract from there
                                if (!taskPath) {
                                    const linkElement = taskElement.querySelector('a.internal-link');
                                    if (linkElement) {
                                        const href = linkElement.getAttribute('href') || '';
                                        // Extract file path from href (format could be 'file.md' or 'file.md#heading')
                                        if (href) {
                                            const parts = href.split('#');
                                            if (parts[0]) {
                                                taskPath = parts[0];
                                            }
                                        }
                                    }
                                }
                                
                                // If still no path, check if the task text contains a file link
                                if (!taskPath && taskText.includes('[[')) {
                                    const linkMatch = taskText.match(/\[\[(.*?)(\|.*?)?\]\]/);
                                    if (linkMatch && linkMatch[1]) {
                                        taskPath = linkMatch[1] + '.md'; // Add .md extension if missing
                                    }
                                }
                                
                                // Get the line number
                                taskLine = parseInt(dataLine) || 0;
                                
                                // Check if task is checked/completed
                                const isChecked = 
                                    taskElement.classList.contains('is-checked') || 
                                    taskElement.querySelector('input[type="checkbox"]:checked') !== null ||
                                    taskText.includes('[x]') ||
                                    taskText.includes('[X]');
                                
                                // Get the fileName from the path
                                let fileName = '';
                                if (taskPath) {
                                    const pathParts = taskPath.split('/');
                                    fileName = pathParts[pathParts.length - 1];
                                }
                                
                                console.log(`Pomodoro Timer: Extracted task from DOM: ${taskText} (${taskPath || 'unknown'}:${taskLine})`);
                                
                                // Create a synthetic task object
                                allTasks.push({
                                    text: taskText,
                                    path: taskPath || '',
                                    file: { path: taskPath || '' },
                                    fileName: fileName || 'Unknown',
                                    name: taskText.replace(/^\s*- \[[x ]\]\s*/, '').trim(), // Remove checkbox
                                    line: taskLine,
                                    checked: isChecked,
                                    description: taskText,
                                    status: isChecked ? 'x' : ' ',
                                    blockLink: '',
                                    done: '',
                                    due: '',
                                    created: '',
                                    cancelled: '',
                                    scheduled: '',
                                    start: '',
                                    priority: '',
                                    recurrence: '',
                                    expected: 0,
                                    actual: 0,
                                    tags: [],
                                    source: 'dom',
                                });
                            } catch (err) {
                                console.error("Pomodoro Timer: Error extracting task from DOM:", err);
                            }
                        });
                    });
                    
                    console.log(`Pomodoro Timer: Extracted ${allTasks.length} tasks from DOM`);
                }
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
            
            // Process tasks - be more selective about what we include
            // First get current tasks to check for duplicates
            const existingTasks: TaskItem[] = [];
            this._store.subscribe(state => {
                existingTasks.push(...state.list);
            })();
            
            // Collect valid tasks
            for (const task of allTasks) {
                try {
                    // Skip tasks with no valid text
                    const taskText = task.text || task.description || '';
                    if (!taskText.trim()) {
                        continue;
                    }
                    
                    // Extract the necessary information from the task
                    const filePath = task.file?.path || task.filePath || task.path || '';
                    
                    // Skip tasks with invalid or empty file paths, unless they're from DOM extraction
                    if (!filePath && task.source !== 'dom') {
                        console.log("Skipping task with no file path:", taskText);
                        continue;
                    }
                    
                    let lineNumber = task.line || task.position?.start?.line || task.lineNumber || 0;
                    
                    // Check if the file exists (unless it's from DOM)
                    let taskFile: TFile | null = null;
                    if (filePath) {
                        const abstractFile = this.plugin.app.vault.getAbstractFileByPath(filePath);
                        if (abstractFile instanceof TFile) {
                            taskFile = abstractFile;
                        } else if (task.source !== 'dom') {
                            console.log("Skipping task from file that doesn't exist:", filePath);
                            continue;
                        }
                    }
                    
                    // Make sure we have a fileName
                    const fileName = taskFile?.name || 
                                    task.fileName || 
                                    (filePath ? filePath.split('/').pop() : '') || 
                                    'Unknown';
                    
                    // Get the task line content and extract components
                    let line = task.text || '';
                    let components: any = null;
                    
                    // For DOM-extracted tasks or when we can't read the file
                    if (task.source === 'dom' || !taskFile) {
                        // Create synthetic components from what we have
                        const bodyText = taskText.replace(/^\s*- \[[x ]\]\s*/, '').trim(); // Remove checkbox
                        components = {
                            status: task.checked ? 'x' : ' ',
                            body: bodyText,
                            blockLink: task.blockLink || '',
                        };
                    } else {
                        try {
                            // Read the file content to get the line
                            const fileContent = await this.plugin.app.vault.cachedRead(taskFile);
                            const lines = fileContent.split('\n');
                            
                            if (lineNumber >= lines.length) {
                                console.log(`Skipping task with invalid line number: ${lineNumber} in file: ${filePath}`);
                                continue;
                            }
                            
                            line = lines[lineNumber];
                            components = extractTaskComponents(line);
                            
                            if (!components) {
                                console.log(`Skipping task with no valid components at line ${lineNumber}: ${line}`);
                                continue;
                            }
                        } catch (error) {
                            console.log("Error reading task file:", error);
                            continue;
                        }
                    }
                    
                    // Check for duplicates
                    // A task is a duplicate if it has the same blockLink or (same line number and file path)
                    const taskIdentifier = components.blockLink || `${filePath}:${lineNumber}`;
                    const isDuplicate = existingTasks.some((existingTask: TaskItem) => {
                        return (components.blockLink && existingTask.blockLink === components.blockLink) || 
                              (existingTask.line === lineNumber && existingTask.path === filePath);
                    });
                    
                    if (isDuplicate) {
                        console.log(`Skipping duplicate task: ${taskText}`);
                        continue;
                    }
                    
                    // Parse task details with our standard serializer
                    const detail = DESERIALIZERS[this.plugin.getSettings().taskFormat].deserialize(components.body);
                    const [actual, expected] = (detail.pomodoros || "0/0").split('/');
                    const dateformat = 'YYYY-MM-DD';
                    
                    // Get the best description we can
                    const taskDescription = detail.description || task.description || components.body || taskText;
                    
                    // Create the TaskItem
                    queriedTasks.push({
                        text: line,
                        path: filePath,
                        fileName: fileName,
                        name: taskDescription,
                        status: components.status,
                        blockLink: components.blockLink || task.blockLink || '',
                        checked: task.checked || (components.status !== ' '),
                        description: taskDescription,
                        done: detail.doneDate?.format(dateformat) ?? task.done ?? '',
                        due: detail.dueDate?.format(dateformat) ?? task.due ?? '',
                        created: detail.createdDate?.format(dateformat) ?? task.created ?? '',
                        cancelled: detail.cancelledDate?.format(dateformat) ?? task.cancelled ?? '',
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
