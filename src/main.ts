import { TimerView, VIEW_TYPE_TIMER } from 'TimerView'
import { Notice, Plugin, WorkspaceLeaf } from 'obsidian'
import PomodoroSettings, { type Settings } from 'Settings'
import StatusBar from 'StatusBarComponent.svelte'
import Timer from 'Timer'
import Tasks from 'Tasks'
import TaskTracker from 'TaskTracker'
import { StateFile } from './StateFile'
import { AsanaTaskModal } from './AsanaTaskModal'
import { IdleReminderModal } from './IdleReminderModal'
import { IdleReminderWindow } from './IdleReminderWindow'
import { exec } from 'child_process'

export default class PomodoroTimerPlugin extends Plugin {
    private settingTab?: PomodoroSettings

    public timer?: Timer

    public tasks?: Tasks

    public tracker?: TaskTracker

    async onload() {
        const settings = await this.loadData()
        this.settingTab = new PomodoroSettings(this, settings)
        this.addSettingTab(this.settingTab)
        this.tracker = new TaskTracker(this)
        this.timer = new Timer(this)
        this.tasks = new Tasks(this)

        // Create a variable to track if tasks should be loaded automatically
        let autoLoadTasks = true;
        
        // Register to the tracker store but don't react to file changes
        this.registerEvent(
            this.tracker.subscribe((state) => {
                // Only load tasks on initial startup
                if (autoLoadTasks) {
                    autoLoadTasks = false; // Reset so it doesn't auto-load on future changes
                    // Load tasks from dataview query regardless of active file
                    if (this.tasks) {
                        this.tasks.reloadTasks();
                    }
                }
                // Otherwise, do nothing when the file changes
            })
        );

        this.registerView(VIEW_TYPE_TIMER, (leaf) => new TimerView(this, leaf))

        // ribbon - timer panel toggle
        this.addRibbonIcon('timer', 'Toggle timer panel', () => {
            let { workspace } = this.app
            let leaves = workspace.getLeavesOfType(VIEW_TYPE_TIMER)
            if (leaves.length > 0) {
                workspace.detachLeavesOfType(VIEW_TYPE_TIMER)
            } else {
                this.activateView()
            }
        })

        // ribbon - Asana task selector
        this.addRibbonIcon('list', 'Select Asana task', () => {
            new AsanaTaskModal(this).open()
        })

        // status bar
        const status = this.addStatusBarItem()
        status.className = `${status.className} mod-clickable`
        new StatusBar({ target: status, props: { store: this.timer } })

        // commands
        this.addCommand({
            id: 'toggle-timer',
            name: 'Toggle timer',
            callback: () => {
                this.timer?.toggleTimer()
            },
        })

        this.addCommand({
            id: 'toggle-timer-panel',
            name: 'Toggle timer panel',
            callback: () => {
                let { workspace } = this.app
                let leaves = workspace.getLeavesOfType(VIEW_TYPE_TIMER)
                if (leaves.length > 0) {
                    workspace.detachLeavesOfType(VIEW_TYPE_TIMER)
                } else {
                    this.activateView()
                }
            },
        })

        this.addCommand({
            id: 'reset-timer',
            name: 'Reset timer',
            callback: () => {
                this.timer?.reset()
                new Notice('Timer reset')
            },
        })

        this.addCommand({
            id: 'toggle-mode',
            name: 'Toggle timer mode',
            callback: () => {
                this.timer?.toggleMode((t) => {
                    new Notice(`Timer mode: ${t.mode}`)
                })
            },
        })
        
        // Add command to load tasks using Dataview query
        this.addCommand({
            id: 'load-tasks',
            name: 'Load tasks from Dataview query',
            callback: () => {
                this.loadTasks();
            },
        })

        // Add command to select Asana task and start timer
        this.addCommand({
            id: 'select-asana-task',
            name: 'Select Asana task and start timer',
            callback: () => {
                new AsanaTaskModal(this).open()
            },
        })

        // Debug command to manually trigger reminder check
        this.addCommand({
            id: 'check-idle-reminder',
            name: 'Check idle reminder now',
            callback: () => {
                this.checkIdleReminder()
            },
        })

        // Force show reminder (bypasses all checks - for testing)
        this.addCommand({
            id: 'force-show-reminder',
            name: 'Force show idle reminder (skip all checks)',
            callback: () => {
                const reminderWindow = new IdleReminderWindow(this)
                reminderWindow.show()
            },
        })

        // Add command to start timer for a task specified in the shared state file
        this.addCommand({
            id: 'start-timer-for-task',
            name: 'Start timer for task from state file',
            callback: async () => {
                const stateFile = new StateFile();
                const state = stateFile.read();

                if (state.task_text) {
                    // Build full task name with customer and tag
                    const fullTaskName = [
                        state.customer,
                        state.task_text,
                        state.tag
                    ].filter(Boolean).join(' ');

                    // Build a TaskItem from the state file data
                    const taskItem = {
                        text: fullTaskName,
                        blockLink: state.task_id || '',
                        name: fullTaskName,
                        description: fullTaskName,
                        path: '',
                        fileName: '',
                        line: -1,
                        status: '',
                        priority: '',
                        tags: state.tag ? [state.tag] : [],
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
                    };

                    // Try to find a matching task from loaded tasks
                    let foundTask = false;
                    if (this.tasks) {
                        const store = this.tasks;
                        let currentTasks: any[] = [];
                        const unsub = store.subscribe((s) => {
                            currentTasks = s.list;
                        });
                        unsub();

                        if (currentTasks.length > 0) {
                            const match = currentTasks.find((t: any) =>
                                (state.task_id && t.blockLink && t.blockLink.replace(/^\^/, '') === state.task_id.replace(/^\^/, '')) ||
                                t.text.includes(state.task_text || '')
                            );
                            if (match) {
                                await this.tracker?.active(match);
                                foundTask = true;
                            }
                        }
                    }

                    // If no match found in loaded tasks, use the constructed task item
                    if (!foundTask) {
                        await this.tracker?.active(taskItem);
                    }

                    // Start the timer
                    this.timer?.start();

                    // Update the state file to mark timer as active
                    stateFile.update({
                        active: true,
                        started_at: new Date().toISOString(),
                    });

                    new Notice(`Timer started: ${state.task_text}`);
                } else {
                    new Notice('No task specified in state file');
                }
            }
        })

        // Log that idle reminder system is initializing
        console.log('🍅 Idle reminder system initializing...')

        // Idle reminder interval - check every 5 minutes
        const intervalId = window.setInterval(() => {
            console.log('5-minute interval idle reminder check')
            this.checkIdleReminder()
        }, 5 * 60 * 1000) // 5 minutes
        this.registerInterval(intervalId)
        console.log('🍅 5-minute interval registered, ID:', intervalId)

        // First check after 15 minutes (give user time to start working)
        window.setTimeout(async () => {
            console.log('🍅 Initial idle reminder check triggered (15m)')
            try {
                await this.checkIdleReminder()
                console.log('🍅 checkIdleReminder completed')
            } catch (e) {
                console.error('🍅 checkIdleReminder ERROR:', e)
            }
        }, 15 * 60 * 1000) // 15 minutes
        console.log('🍅 Initial 15-minute timeout set')
    }

    /**
     * Check if user is in a video meeting
     * Uses WINDOW detection only (process detection is unreliable)
     */
    private async isInMeeting(): Promise<boolean> {
        return new Promise((resolve) => {
            exec('wmctrl -l', { timeout: 1000 }, (error, stdout) => {
                if (error) {
                    resolve(false)
                    return
                }

                const lines = stdout.toLowerCase().split('\n')

                for (const line of lines) {
                    // Zoom: window title contains "zoom meeting" or "zoom webinar"
                    if (line.includes('zoom meeting') || line.includes('zoom webinar')) {
                        console.log('Zoom meeting window detected')
                        resolve(true)
                        return
                    }

                    // Google Meet in browser
                    if (line.includes('meet.google.com')) {
                        console.log('Google Meet detected')
                        resolve(true)
                        return
                    }

                    // Teams meeting detection:
                    // - PWA chat window has "(pwa)" in title - NOT a meeting
                    // - Browser meeting window has "teams" but NO "(pwa)" - IS a meeting
                    if (line.includes('teams') && !line.includes('(pwa)')) {
                        console.log('Teams meeting detected (browser):', line.substring(0, 80))
                        resolve(true)
                        return
                    }
                }
                resolve(false)
            })
        })
    }

    /**
     * Check if we should show an idle reminder
     * Shows reminder if: enabled, weekday, work hours, no timer running, not in meeting
     */
    private async checkIdleReminder() {
        console.log('🍅 checkIdleReminder() ENTER')
        try {
            const settings = this.getSettings()
            console.log('🍅 Got settings')
        console.log('Reminder settings:', {
            enabled: settings.reminderEnabled,
            startHour: settings.reminderStartHour,
            endHour: settings.reminderEndHour
        })

        // Check if reminder is enabled
        if (!settings.reminderEnabled) {
            console.log('Reminder disabled, skipping')
            return
        }

        const now = new Date()
        const day = now.getDay()
        const hour = now.getHours()
        console.log('Current time:', { day, hour, dayName: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day] })

        // Check if weekday (Mon=1, Fri=5)
        if (day === 0 || day === 6) {
            console.log('Weekend, skipping')
            return
        }

        // Check if within work hours
        if (hour < (settings.reminderStartHour ?? 9) || hour >= (settings.reminderEndHour ?? 18)) {
            console.log('Outside work hours, skipping')
            return
        }

        // Check if timer is already running
        let timerRunning = false
        let timerState: any = null
        const unsub = this.timer?.subscribe((state) => {
            timerRunning = state.inSession || state.running
            timerState = { inSession: state.inSession, running: state.running, mode: state.mode }
        })
        if (unsub) unsub()

        console.log('Timer state:', timerState)

        if (timerRunning) {
            console.log('Timer running, skipping')
            return
        }

        // Check if in a meeting - skip reminder if so
        const inMeeting = await this.isInMeeting()
        console.log('In meeting:', inMeeting)
        if (inMeeting) {
            console.log('In meeting, skipping')
            return
        }

        // Show native Electron popup on active monitor
        console.log('All checks passed, showing reminder!')
        const reminderWindow = new IdleReminderWindow(this)
        reminderWindow.show()
        } catch (e) {
            console.error('🍅 checkIdleReminder ERROR:', e)
        }
    }

    public getSettings(): Settings {
        return (
            this.settingTab?.getSettings() || PomodoroSettings.DEFAULT_SETTINGS
        )
    }

    onunload() {
        this.settingTab?.unload()
        this.timer?.destroy()
        this.tasks?.destroy()
        this.tracker?.destory()
    }
    async activateView() {
        let { workspace } = this.app

        let leaf: WorkspaceLeaf | null = null
        let leaves = workspace.getLeavesOfType(VIEW_TYPE_TIMER)

        if (leaves.length > 0) {
            leaf = leaves[0]
        } else {
            leaf = workspace.getRightLeaf(false)
            await leaf.setViewState({
                type: VIEW_TYPE_TIMER,
                active: true,
            })
        }

        workspace.revealLeaf(leaf)
    }

    public loadTasks() {
        // Load tasks using dataview query regardless of active file
        if (this.tasks) {
            this.tasks.reloadTasks();
        }
    }
}
