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
                        if (state.file?.path !== file?.path) {
                            state.task = undefined
                        }
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
        const normalizedSearchBlockLink = blockLink.replace(/^\^/, '');
        console.log('DEBUG: Looking for block link:', blockLink);
        console.log('DEBUG: Normalized search block link:', normalizedSearchBlockLink);

        for (let rawElement of metadata.listItems || []) {
            if (rawElement.task) {
                let lineNr = rawElement.position.start.line
                let originalLine = lines[lineNr];
                let line = originalLine;
                
                console.log('DEBUG: Examining line:', line);

                const components = extractTaskComponents(line)

                if (!components) {
                    continue
                }
                
                console.log('DEBUG: Line components:', components);
                
                // Normalize the component blockLink for comparison
                const componentBlockLink = components.blockLink.trim().replace(/^\^/, '');
                console.log('DEBUG: Component block link:', components.blockLink);
                console.log('DEBUG: Normalized component block link:', componentBlockLink);
                
                // Compare the normalized block links
                const isMatch = componentBlockLink === normalizedSearchBlockLink;
                console.log('DEBUG: Is match?', isMatch, 
                            '(comparing "' + componentBlockLink + '" with "' + normalizedSearchBlockLink + '")');

                if (isMatch) {
                    console.log('DEBUG: Found matching block link!');

                    // First check if we have a bracketed pomodoro count
                    const hasPomodoroCount = components.body.includes('[🍅::');
                    console.log('DEBUG: Has pomodoro count?', hasPomodoroCount);
                    
                    if (hasPomodoroCount) {
                        try {
                            // Find the starting position of the pomodoro count
                            const startPos = line.indexOf('[🍅::');
                            if (startPos !== -1) {
                                // Find the ending position (closing bracket)
                                const endPos = line.indexOf(']', startPos);
                                if (endPos !== -1) {
                                    // Extract the pomodoro text
                                    const pomodoroText = line.substring(startPos, endPos + 1);
                                    console.log('DEBUG: Found pomodoro text:', pomodoroText);
                                    
                                    // Parse the count number
                                    const countMatch = pomodoroText.match(/\[🍅::\s*(\d+)(?:\/(\d+))?\s*\]/);
                                    if (countMatch) {
                                        const currentCount = parseInt(countMatch[1] || '0');
                                        console.log('DEBUG: Current count:', currentCount);
                                        
                                        // Create the new pomodoro text
                                        let newPomodoroText = `[🍅:: ${currentCount + 1}`;
                                        if (countMatch[2]) {
                                            newPomodoroText += `/${countMatch[2]}`;
                                        }
                                        newPomodoroText += `]`;
                                        
                                        console.log('DEBUG: New pomodoro text:', newPomodoroText);
                                        
                                        // Build the new line by replacing just the pomodoro part
                                        const newLine = line.substring(0, startPos) + 
                                                        newPomodoroText + 
                                                        line.substring(endPos + 1);
                                        console.log('DEBUG: New line:', newLine);
                                        
                                        // Verify the replacement worked
                                        if (newLine !== line) {
                                            line = newLine;
                                        } else {
                                            console.log('DEBUG: WARNING - Line unchanged after replacement!');
                                        }
                                    }
                                }
                            }
                        } catch (error) {
                            console.log('DEBUG: Error processing pomodoro count:', error);
                        }
                    } else {
                        console.log('DEBUG: No pomodoro count found, adding one');
                        // Add a new pomodoro count before the block ID
                        if (components.blockLink) {
                            const blockPos = line.indexOf(components.blockLink);
                            if (blockPos !== -1) {
                                line = line.substring(0, blockPos) + 
                                      ` [🍅:: 1]` + 
                                      line.substring(blockPos);
                            } else {
                                // Fallback - add at the end
                                line = line + ` [🍅:: 1]`;
                            }
                        } else {
                            // No block ID, add at the end
                            line = line + ` [🍅:: 1]`;
                        }
                    }
                    
                    console.log('DEBUG: Final line:', line);
                    console.log('DEBUG: Original line:', originalLine);
                    console.log('DEBUG: Changed?', line !== originalLine);
                    
                    if (line !== originalLine) {
                        lines[lineNr] = line;
                        
                        await this.plugin.app.vault.modify(file, lines.join('\n'));
                        
                        this.plugin.app.metadataCache.trigger(
                            'changed',
                            file,
                            content,
                            metadata,
                        );
                        
                        this.plugin.app.workspace
                            .getActiveViewOfType(MarkdownView)
                            ?.load();
                        
                        console.log('DEBUG: Successfully updated the file!');
                    } else {
                        console.log('DEBUG: No changes made to the line!');
                    }
                    break;
                }
            }
        }
    }
}
