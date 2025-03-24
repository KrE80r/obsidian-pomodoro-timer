import { type TaskItem } from 'Tasks'
import type PomodoroTimerPlugin from 'main'
import { TFile, Keymap, MarkdownView } from 'obsidian'
import { DESERIALIZERS, POMODORO_REGEX } from 'serializer'
import {
    writable,
    type Readable,
    type Writable,
    type Unsubscriber,
} from 'svelte/store'
import { extractTaskComponents } from 'utils'

export type TaskTrackerState = {
    task?: TaskItem
    file?: TFile
    pinned: boolean
}

type TaskTrackerStore = Readable<TaskTrackerState>

const DEFAULT_TRACKER_STATE: TaskTrackerState = {
    pinned: false,
}

export default class TaskTracker implements TaskTrackerStore {
    private plugin

    private state: TaskTrackerState

    private store: Writable<TaskTrackerState>

    public subscribe

    private unsubscribers: Unsubscriber[] = []

    constructor(plugin: PomodoroTimerPlugin) {
        this.plugin = plugin
        this.state = DEFAULT_TRACKER_STATE
        this.store = writable(this.state)
        this.subscribe = this.store.subscribe
        this.unsubscribers.push(
            this.store.subscribe((state) => {
                this.state = state
            }),
        )

        plugin.registerEvent(
            //loadtasks on file change
            plugin.app.workspace.on('active-leaf-change', () => {
                let file = this.plugin.app.workspace.getActiveFile()
                if (!this.state.pinned) {
                    this.store.update((state) => {
                        // Don't clear the task when changing files
                        // Keep state.task as is to persist selection across files
                        state.file = file ?? state.file
                        return state
                    })
                }
            }),
        )

        plugin.app.workspace.onLayoutReady(() => {
            let file = this.plugin.app.workspace.getActiveFile()
            this.store.update((state) => {
                state.file = file ?? state.file
                return state
            })
        })
    }

    get task() {
        return this.state.task
    }

    get file() {
        return this.state.file
    }

    public togglePinned() {
        this.store.update((state) => {
            state.pinned = !state.pinned
            return state
        })
    }

    public async active(task: TaskItem) {
        await this.ensureBlockId(task)
        this.store.update((state) => {
            state.task = task
            return state
        })
    }

    public setTaskName(name: string) {
        this.store.update((state) => {
            if (state.task) {
                state.task.name = name
            }
            return state
        })
    }

    private async ensureBlockId(task: TaskItem) {
        let file = this.plugin.app.vault.getAbstractFileByPath(task.path)
        if (file && file instanceof TFile) {
            const f = file as TFile
            if (f.extension === 'md') {
                let content = await this.plugin.app.vault.read(f)
                let lines = content.split('\n')
                if (lines.length > task.line) {
                    let line = lines[task.line]
                    if (task.blockLink) {
                        if (!line.endsWith(task.blockLink)) {
                            // block id mismatch?
                            lines[task.line] += `${task.blockLink}`
                            this.plugin.app.vault.modify(f, lines.join('\n'))
                            return
                        }
                    } else {
                        // generate block id
                        let blockId = this.createBlockId()
                        task.blockLink = blockId
                        lines[task.line] += `${blockId}`
                        this.plugin.app.vault.modify(f, lines.join('\n'))
                    }
                }
            }
        }
    }

    private createBlockId() {
        return ` ^${Math.random().toString(36).substring(2, 6)}`
    }

    public clear() {
        this.store.update((state) => {
            state.task = undefined
            return state
        })
    }

    public openFile(event: MouseEvent) {
        if (this.state.file) {
            const leaf = this.plugin.app.workspace.getLeaf(
                Keymap.isModEvent(event),
            )
            leaf.openFile(this.state.file)
        }
    }

    public openTask = (event: MouseEvent, task: TaskItem) => {
        let file = this.plugin.app.vault.getAbstractFileByPath(task.path)
        if (file && file instanceof TFile && task.line >= 0) {
            const leaf = this.plugin.app.workspace.getLeaf(
                Keymap.isModEvent(event),
            )
            leaf.openFile(file, { eState: { line: task.line } })
        }
    }

    get pinned() {
        return this.state.pinned
    }

    public finish() {}

    public destory() {
        for (let unsub of this.unsubscribers) {
            unsub()
        }
    }

    public sync(task: TaskItem) {
        if (
            this.state.task?.blockLink &&
            this.state.task.blockLink === task.blockLink
        ) {
            this.store.update((state) => {
                if (state.task) {
                    let name = state.task.name
                    state.task = { ...task, name }
                }
                return state
            })
        }
    }

    public async updateActual() {
        // update task item
        if (
            this.plugin.getSettings().enableTaskTracking &&
            this.task &&
            this.task.blockLink
        ) {
            let file = this.plugin.app.vault.getAbstractFileByPath(
                this.task.path,
            )
            if (file && file instanceof TFile) {
                let f = file as TFile
                this.store.update((state) => {
                    if (state.task) {
                        if (state.task.actual >= 0) {
                            state.task.actual += 1
                        } else {
                            state.task.actual = 1
                        }
                    }
                    return state
                })
                await this.incrTaskActual(this.task.blockLink, f)
            }
        }
    }

    private async incrTaskActual(blockLink: string, file: TFile) {
        const format = this.plugin.getSettings().taskFormat

        if (file.extension !== 'md') {
            return
        }

        let metadata = this.plugin.app.metadataCache.getFileCache(file)
        let content = await this.plugin.app.vault.read(file)

        if (!content || !metadata) {
            return
        }

        const lines = content.split('\n')
        
        // Normalize the blockLink - remove caret if present in the search parameter
        const normalizedSearchBlockLink = blockLink.replace(/^\^/, '').trim();
        console.log('DEBUG: Looking for block link:', blockLink, 'normalized:', normalizedSearchBlockLink);

        let foundMatch = false;
        let lineToUpdate = -1;
        
        for (let rawElement of metadata.listItems || []) {
            if (rawElement.task) {
                let lineNr = rawElement.position.start.line
                let originalLine = lines[lineNr];
                let line = originalLine;
                
                // First try to match by blockLink
                if (line.includes(`^${normalizedSearchBlockLink}`)) {
                    console.log('DEBUG: Found task by exact block ID match:', line);
                    foundMatch = true;
                    lineToUpdate = lineNr;
                    break;
                }
                
                // Then try to extract and compare components
                const components = extractTaskComponents(line)
                if (!components) {
                    continue
                }
                
                // Check if the blockLink matches (normalized to handle different formats)
                const componentBlockId = components.blockLink?.replace(/^\^/, '').trim();
                if (componentBlockId && componentBlockId === normalizedSearchBlockLink) {
                    console.log('DEBUG: Found task by component block ID match:', componentBlockId);
                    foundMatch = true;
                    lineToUpdate = lineNr;
                    break;
                }
            }
        }

        if (foundMatch && lineToUpdate >= 0) {
            console.log('DEBUG: Found task to update at line:', lineToUpdate);
            const originalLine = lines[lineToUpdate];
            
            // Use multiple patterns to detect existing pomodoro count
            const pomodoroPatterns = [
                /\[🍅::\s*(\d+)\]/,      // Standard format [🍅:: 3]
                /🍅\s*(\d+)/,            // Simple format 🍅 3
                /\[\s*🍅\s*:\s*(\d+)\s*\]/  // Alternative format [🍅: 3]
            ];
            
            let updatedLine = originalLine;
            let patternFound = false;
            
            for (const pattern of pomodoroPatterns) {
                if (pattern.test(originalLine)) {
                    // Update existing pomodoro count
                    updatedLine = originalLine.replace(pattern, (match, count) => {
                        const newCount = parseInt(count) + 1;
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
            
            // If no pomodoro count found, add it before any block ID or metadata
            if (!patternFound) {
                // Look for a block ID or other metadata to insert before
                const metadataPattern = /(\s+(?:➕|📅|⏳|✅)\s+\d{4}-\d{2}-\d{2}|\s+#[\w\d/-]+|\s+\^[\w\d-]+)(?:\s|$)/;
                const blockIdMatch = originalLine.match(metadataPattern);
                
                if (blockIdMatch && blockIdMatch.index !== undefined) {
                    // Insert before the first metadata item
                    updatedLine = 
                        originalLine.substring(0, blockIdMatch.index) + 
                        ` [🍅:: 1]` + 
                        originalLine.substring(blockIdMatch.index);
                } else {
                    // Just append to the end
                    updatedLine += ` [🍅:: 1]`;
                }
            }
            
            // Update the line in the file
            if (updatedLine !== originalLine) {
                lines[lineToUpdate] = updatedLine;
                await this.plugin.app.vault.modify(file, lines.join('\n'));
                console.log('DEBUG: Updated task with new pomodoro count:', updatedLine);
            } else {
                console.warn('DEBUG: Failed to update line - no changes made:', originalLine);
            }
        } else {
            console.warn('DEBUG: Failed to find task with block link:', normalizedSearchBlockLink);
        }
    }
}
