// src/IdleReminderWindow.ts
// Creates a native Electron popup window for idle reminders
// This appears on the active monitor, always on top

import type PomodoroTimerPlugin from 'main'
import { AsanaTaskLoader, type AsanaTask } from './AsanaTaskLoader'

export class IdleReminderWindow {
    private plugin: PomodoroTimerPlugin
    private win: any = null

    constructor(plugin: PomodoroTimerPlugin) {
        this.plugin = plugin
    }

    async show(): Promise<void> {
        try {
            // Access Electron APIs
            const electron = require('electron')
            const remote = electron.remote || (require('@electron/remote') as any)
            const { BrowserWindow, screen } = remote

            // Get cursor position to determine active monitor
            const cursorPoint = screen.getCursorScreenPoint()
            const activeDisplay = screen.getDisplayNearestPoint(cursorPoint)
            const { x, y, width, height } = activeDisplay.workArea

            // Window dimensions
            const winWidth = 450
            const winHeight = 380

            // Center on active monitor
            const winX = Math.round(x + (width - winWidth) / 2)
            const winY = Math.round(y + (height - winHeight) / 2)

            // Get Obsidian theme colors
            const colors = this.getObsidianColors()

            // Create the window
            this.win = new BrowserWindow({
                width: winWidth,
                height: winHeight,
                x: winX,
                y: winY,
                frame: false,
                alwaysOnTop: true,
                resizable: false,
                skipTaskbar: true,
                transparent: false,
                backgroundColor: colors.bgPrimary,
                webPreferences: {
                    nodeIntegration: true,
                    contextIsolation: false,
                }
            })

            // Load tasks for the dropdown
            const loader = new AsanaTaskLoader()
            const tasks = loader.load()

            // Build HTML content with Obsidian colors
            const html = this.buildHTML(tasks, colors)

            // Load the HTML
            this.win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

            // Handle IPC from the window
            const { ipcMain } = remote

            // Clean up old listeners
            ipcMain.removeAllListeners('idle-reminder-select-task')
            ipcMain.removeAllListeners('idle-reminder-dismiss')

            ipcMain.once('idle-reminder-select-task', (_event: any, taskIndex: number) => {
                if (tasks[taskIndex]) {
                    this.startTask(tasks[taskIndex])
                }
                this.close()
            })

            ipcMain.once('idle-reminder-dismiss', () => {
                this.close()
            })

            // Focus the window
            this.win.focus()

        } catch (error) {
            console.error('Failed to create idle reminder window:', error)
            // Fallback to regular modal if Electron APIs not available
            const { IdleReminderModal } = require('./IdleReminderModal')
            new IdleReminderModal(this.plugin).open()
        }
    }

    /**
     * Extract colors from Obsidian's current theme
     */
    private getObsidianColors(): Record<string, string> {
        const body = document.body
        const style = getComputedStyle(body)

        return {
            bgPrimary: style.getPropertyValue('--background-primary').trim() || '#1e1e1e',
            bgSecondary: style.getPropertyValue('--background-secondary').trim() || '#262626',
            bgModifier: style.getPropertyValue('--background-modifier-border').trim() || '#404040',
            textNormal: style.getPropertyValue('--text-normal').trim() || '#dcddde',
            textMuted: style.getPropertyValue('--text-muted').trim() || '#999',
            textFaint: style.getPropertyValue('--text-faint').trim() || '#666',
            textError: style.getPropertyValue('--text-error').trim() || '#ff6b6b',
            interactive: style.getPropertyValue('--interactive-accent').trim() || '#7c3aed',
            interactiveHover: style.getPropertyValue('--interactive-accent-hover').trim() || '#8b5cf6',
        }
    }

    private buildHTML(tasks: AsanaTask[], colors: Record<string, string>): string {
        const taskOptions = tasks.map((task, idx) => {
            const color = AsanaTaskLoader.getCustomerColor(task.customer)
            return `<option value="${idx}" data-color="${color}">${task.customer} - ${task.text}</option>`
        }).join('')

        return `
<!DOCTYPE html>
<html>
<head>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: ${colors.bgPrimary};
            color: ${colors.textNormal};
            padding: 30px;
            text-align: center;
            user-select: none;
            -webkit-app-region: drag;
        }
        .emoji { font-size: 64px; margin-bottom: 15px; }
        h1 {
            font-size: 24px;
            color: ${colors.textError};
            margin-bottom: 8px;
            font-weight: 600;
        }
        .subtitle {
            font-size: 14px;
            color: ${colors.textMuted};
            margin-bottom: 25px;
        }
        select {
            width: 100%;
            padding: 12px 15px;
            font-size: 14px;
            border: 1px solid ${colors.bgModifier};
            border-radius: 6px;
            background: ${colors.bgSecondary};
            color: ${colors.textNormal};
            margin-bottom: 20px;
            cursor: pointer;
            -webkit-app-region: no-drag;
        }
        select:focus { outline: none; border-color: ${colors.textMuted}; }
        .buttons {
            display: flex;
            gap: 12px;
            justify-content: center;
            -webkit-app-region: no-drag;
        }
        button {
            padding: 12px 24px;
            font-size: 14px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 500;
            transition: transform 0.1s, opacity 0.1s;
        }
        button:hover { opacity: 0.9; }
        button:active { transform: scale(0.98); }
        .start-btn {
            background: #e74c3c;
            color: white;
            flex: 1;
        }
        .start-btn:hover {
            background: #c0392b;
        }
        .dismiss-btn {
            background: ${colors.bgSecondary};
            color: ${colors.textMuted};
            border: 1px solid ${colors.bgModifier};
        }
        .hint {
            margin-top: 20px;
            font-size: 11px;
            color: ${colors.textFaint};
        }
    </style>
</head>
<body>
    <div class="emoji">🍅</div>
    <h1>No Timer Running!</h1>
    <p class="subtitle">What are you working on?</p>

    <select id="taskSelect">
        <option value="">-- Select a task --</option>
        ${taskOptions}
    </select>

    <div class="buttons">
        <button class="start-btn" id="startBtn" disabled>▶ Start Timer</button>
        <button class="dismiss-btn" id="dismissBtn">Later</button>
    </div>

    <p class="hint">Reminder returns in 5 minutes</p>

    <script>
        const { ipcRenderer } = require('electron')

        const select = document.getElementById('taskSelect')
        const startBtn = document.getElementById('startBtn')
        const dismissBtn = document.getElementById('dismissBtn')

        select.addEventListener('change', () => {
            startBtn.disabled = select.value === ''
        })

        startBtn.addEventListener('click', () => {
            if (select.value !== '') {
                ipcRenderer.send('idle-reminder-select-task', parseInt(select.value))
            }
        })

        dismissBtn.addEventListener('click', () => {
            ipcRenderer.send('idle-reminder-dismiss')
        })

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                ipcRenderer.send('idle-reminder-dismiss')
            } else if (e.key === 'Enter' && select.value !== '') {
                ipcRenderer.send('idle-reminder-select-task', parseInt(select.value))
            }
        })

        // Focus select on load
        select.focus()
    </script>
</body>
</html>`
    }

    private async startTask(task: AsanaTask): Promise<void> {
        const { AsanaTaskModal } = require('./AsanaTaskModal')
        const fullTaskName = AsanaTaskLoader.formatLabel(task)

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
    }

    close(): void {
        if (this.win && !this.win.isDestroyed()) {
            this.win.close()
        }
        this.win = null
    }
}
