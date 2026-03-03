// src/IdleReminderWindow.ts
// Launches a Python/Tk popup for idle reminders
// Shows on active monitor with search, color-coded badges, and new task creation

import type PomodoroTimerPlugin from 'main'
import { AsanaTaskLoader, type AsanaTask } from './AsanaTaskLoader'
import { exec } from 'child_process'
import { Notice } from 'obsidian'
import * as fs from 'fs'
import * as path from 'path'

const POPUP_SCRIPT = path.join(process.env.HOME || '', '.local/share/time-tracker/idle-reminder-popup.py')
const RESULT_FILE = path.join(process.env.HOME || '', '.local/share/time-tracker/popup-result.json')

export class IdleReminderWindow {
    private plugin: PomodoroTimerPlugin

    constructor(plugin: PomodoroTimerPlugin) {
        this.plugin = plugin
    }

    async show(): Promise<void> {
        console.log('IdleReminderWindow.show() called - launching Python popup')

        // Refresh tasks from Dataview query and export to tasks.json
        try {
            console.log('Refreshing tasks from Dataview query...')
            await this.plugin.tasks?.reloadTasks()

            // Get tasks from the store and export to tasks.json for the popup
            let taskList: any[] = []
            const unsub = this.plugin.tasks?.subscribe((state) => {
                taskList = state.list || []
            })
            if (unsub) unsub()

            if (taskList.length > 0) {
                console.log(`Exporting ${taskList.length} tasks to tasks.json for popup`)
                this.exportTasksForPopup(taskList)
            } else {
                console.log('No tasks from Dataview, checking Asana bridge...')
                // Fallback: trigger Asana bridge sync if no Dataview tasks
                const asanaBridge = (this.plugin.app as any).plugins?.plugins?.['obsidian-asana-bridge']
                if (asanaBridge?.syncService?.fetchAsanaTasks) {
                    await asanaBridge.syncService.fetchAsanaTasks()
                }
            }
        } catch (e) {
            console.log('Could not refresh tasks:', e)
        }

        // Remove old result file
        try {
            if (fs.existsSync(RESULT_FILE)) {
                fs.unlinkSync(RESULT_FILE)
            }
        } catch (e) {
            console.log('Could not remove old result file:', e)
        }

        // Launch Python popup (use system Python which has tkinter)
        const cmd = `/usr/bin/python3 "${POPUP_SCRIPT}"`
        console.log('Running:', cmd)

        exec(cmd, { timeout: 300000 }, (error, stdout, stderr) => {
            if (error) {
                console.log('Popup closed or failed:', error.message)
            }

            // Read result file
            this.readResultAndStart()
        })
    }

    private readResultAndStart(): void {
        try {
            if (!fs.existsSync(RESULT_FILE)) {
                console.log('No result file - user dismissed')
                return
            }

            const data = fs.readFileSync(RESULT_FILE, 'utf8')
            const result = JSON.parse(data)
            console.log('Popup result:', result)

            if (result.selected && result.task) {
                this.startTask(result.task as AsanaTask)
            }

            // Clean up
            fs.unlinkSync(RESULT_FILE)
        } catch (e) {
            console.error('Error reading result:', e)
        }
    }

    private async startTask(task: AsanaTask): Promise<void> {
        const fullTaskName = AsanaTaskLoader.formatLabel(task)
        console.log('Starting task:', fullTaskName)

        // Build TaskItem
        const taskItem = {
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

        // Activate and start timer
        await this.plugin.tracker?.active(taskItem)

        // Force WORK mode if in BREAK
        let currentMode = 'WORK'
        const unsub = this.plugin.timer?.subscribe((state) => {
            currentMode = state.mode
        })
        if (unsub) unsub()

        if (currentMode === 'BREAK') {
            this.plugin.timer?.toggleMode()
        }

        this.plugin.timer?.start()

        // Update state file
        const { StateFile } = require('./StateFile')
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

        new Notice(`Timer started: ${task.customer} - ${task.text}`)
    }

    close(): void {
        // Python popup handles its own cleanup
    }

    /**
     * Export tasks to JSON file for the Python popup to read
     * Converts TaskItem format to the popup's expected format
     */
    private exportTasksForPopup(tasks: any[]): void {
        const TASKS_FILE = path.join(process.env.HOME || '', '.local/share/time-tracker/tasks.json')

        // Convert TaskItem to popup format
        const exportedTasks = tasks.map(task => {
            // Try to extract customer from tags
            let customer = 'Internal'
            let tag = '#internal'

            if (task.tags && task.tags.length > 0) {
                // Look for customer tags like #cba, #qantas, #kiwi, #bnz
                const customerTags: Record<string, string> = {
                    '#cba': 'CBA',
                    '#qantas': 'Qantas',
                    '#kiwi': 'Kiwi',
                    '#bnz': 'BNZ',
                    '#westpac': 'Westpac',
                    '#internal': 'Internal'
                }

                for (const t of task.tags) {
                    const lower = t.toLowerCase()
                    if (customerTags[lower]) {
                        customer = customerTags[lower]
                        tag = lower
                        break
                    }
                }
            }

            return {
                text: task.name || task.text || task.description || 'Untitled task',
                asana_url: '',  // Dataview tasks don't have Asana URLs
                customer: customer,
                tag: tag,
                status: task.status || ''
            }
        })

        try {
            const dir = path.dirname(TASKS_FILE)
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true })
            }
            fs.writeFileSync(TASKS_FILE, JSON.stringify(exportedTasks, null, 2))
            console.log(`Exported ${exportedTasks.length} tasks to ${TASKS_FILE}`)
        } catch (e) {
            console.error('Failed to export tasks:', e)
        }
    }
}
