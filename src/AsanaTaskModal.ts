// src/AsanaTaskModal.ts
import { FuzzySuggestModal, Notice, type FuzzyMatch } from 'obsidian'
import type PomodoroTimerPlugin from 'main'
import { AsanaTaskLoader, type AsanaTask } from './AsanaTaskLoader'
import { StateFile } from './StateFile'
import type { TaskItem } from 'Tasks'

export class AsanaTaskModal extends FuzzySuggestModal<AsanaTask> {
    private plugin: PomodoroTimerPlugin
    private loader: AsanaTaskLoader
    private tasks: AsanaTask[]

    constructor(plugin: PomodoroTimerPlugin) {
        super(plugin.app)
        this.plugin = plugin
        this.loader = new AsanaTaskLoader()
        this.tasks = this.loader.load()

        this.setPlaceholder('Select a task to start timer...')
        this.setInstructions([
            { command: '↑↓', purpose: 'to navigate' },
            { command: '↵', purpose: 'to select' },
            { command: 'esc', purpose: 'to dismiss' },
        ])
    }

    getItems(): AsanaTask[] {
        return this.tasks
    }

    getItemText(task: AsanaTask): string {
        return AsanaTaskLoader.formatLabel(task)
    }

    renderSuggestion(match: FuzzyMatch<AsanaTask>, el: HTMLElement): void {
        const task = match.item

        // Container
        el.addClass('asana-task-suggestion')

        // Customer badge
        const badge = el.createSpan({ cls: 'asana-customer-badge' })
        badge.setText(task.customer)
        badge.style.backgroundColor = AsanaTaskLoader.getCustomerColor(task.customer)
        badge.style.color = this.getContrastColor(AsanaTaskLoader.getCustomerColor(task.customer))
        badge.style.padding = '2px 6px'
        badge.style.borderRadius = '3px'
        badge.style.marginRight = '8px'
        badge.style.fontSize = '0.85em'
        badge.style.fontWeight = '500'

        // Task text
        const textSpan = el.createSpan({ cls: 'asana-task-text' })
        textSpan.setText(task.text)

        // Tag
        const tagSpan = el.createSpan({ cls: 'asana-task-tag' })
        tagSpan.setText(task.tag)
        tagSpan.style.marginLeft = '8px'
        tagSpan.style.opacity = '0.6'
        tagSpan.style.fontSize = '0.9em'
    }

    async onChooseItem(task: AsanaTask): Promise<void> {
        // Build the full task name with customer + text + tag
        const fullTaskName = AsanaTaskLoader.formatLabel(task)

        // Build a TaskItem for the tracker
        const taskItem: TaskItem = {
            text: fullTaskName,
            blockLink: '',
            name: fullTaskName,
            description: fullTaskName,
            path: '',
            fileName: '',
            line: -1,
            status: task.status || '',
            priority: '',
            tags: task.tag ? [task.tag] : [],
            actual: 0,
            expected: 0,
            checked: false,
            done: '',
            due: '',
            created: '',
            cancelled: '',
            scheduled: '',
            start: '',
            recurrence: '',
        }

        // Activate the task in tracker
        await this.plugin.tracker?.active(taskItem)

        // Start the timer
        this.plugin.timer?.start()

        // Update the state file for external tools
        const stateFile = new StateFile()
        stateFile.write({
            active: true,
            task_text: task.text,
            asana_url: task.asana_url,
            customer: task.customer,
            tag: task.tag,
            started_at: new Date().toISOString(),
            duration_minutes: this.plugin.getSettings().workLen,
        })

        // Show notification
        new Notice(`Timer started: ${task.customer} - ${task.text}`)
    }

    /**
     * Calculate contrasting text color for badge
     */
    private getContrastColor(hexColor: string): string {
        // Convert hex to RGB
        const r = parseInt(hexColor.slice(1, 3), 16)
        const g = parseInt(hexColor.slice(3, 5), 16)
        const b = parseInt(hexColor.slice(5, 7), 16)

        // Calculate luminance
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255

        return luminance > 0.5 ? '#000000' : '#ffffff'
    }
}
