import type PomodoroTimerPlugin from 'main'
import { DropdownComponent } from 'obsidian'
import { PluginSettingTab, Setting, moment } from 'obsidian'
import type { Unsubscriber } from 'svelte/motion'
import { writable, type Writable } from 'svelte/store'
import {
    appHasDailyNotesPluginLoaded,
    appHasWeeklyNotesPluginLoaded,
    getTemplater,
} from 'utils'

type LogFileType = 'DAILY' | 'WEEKLY' | 'FILE' | 'NONE'
type LogLevel = 'ALL' | 'WORK' | 'BREAK'
type LogFormat = 'SIMPLE' | 'VERBOSE' | 'CUSTOM'
export type TaskFormat = 'TASKS' | 'DATAVIEW'

export interface Settings {
    workLen: number
    breakLen: number
    autostart: boolean
    useStatusBarTimer: boolean
    notificationSound: boolean
    enableTaskTracking: boolean
    showTaskProgress: boolean
    customSound: string
    logFile: LogFileType
    logFocused: boolean
    logPath: string
    logLevel: LogLevel
    logTemplate: string
    logFormat: LogFormat
    useSystemNotification: boolean
    taskFormat: TaskFormat
    lowFps: boolean
    taskQuery: string
}

export default class PomodoroSettings extends PluginSettingTab {
    static readonly DEFAULT_SETTINGS: Settings = {
        workLen: 25,
        breakLen: 5,
        autostart: false,
        useStatusBarTimer: false,
        notificationSound: true,
        customSound: '',
        showTaskProgress: true,
        enableTaskTracking: false,
        logFile: 'NONE',
        logFocused: false,
        logPath: '',
        logLevel: 'ALL',
        logTemplate: '',
        logFormat: 'VERBOSE',
        useSystemNotification: false,
        taskFormat: 'TASKS',
        lowFps: false,
        taskQuery: `TASK FROM "0-Daily notes"
WHERE !completed`,
    }

    static settings: Writable<Settings> = writable(
        PomodoroSettings.DEFAULT_SETTINGS,
    )

    private _settings: Settings

    private plugin: PomodoroTimerPlugin

    private unsubscribe: Unsubscriber

    constructor(plugin: PomodoroTimerPlugin, settings: Settings) {
        super(plugin.app, plugin)
        this.plugin = plugin
        this._settings = { ...PomodoroSettings.DEFAULT_SETTINGS, ...settings }
        PomodoroSettings.settings.set(this._settings)
        this.unsubscribe = PomodoroSettings.settings.subscribe((settings) => {
            this.plugin.saveData(settings)
            this._settings = settings
            this.plugin.timer?.setupTimer()
        })
    }

    public getSettings(): Settings {
        return this._settings
    }

    public updateSettings = (
        newSettings: Partial<Settings>,
        refreshUI: boolean = false,
    ) => {
        PomodoroSettings.settings.update((settings) => {
            this._settings = { ...settings, ...newSettings }
            if (refreshUI) {
                this.display()
            }
            return this._settings
        })
    }

    public unload() {
        this.unsubscribe()
    }

    public display() {
        const { containerEl } = this

        // Empty the container element
        containerEl.empty()

        // Create the section element
        const section = containerEl.createEl('section', { cls: 'pomodoro-timer-settings' })
        
        /* ========== Timer Settings ========== */
        
        section.createEl('h3', {
            text: 'Timer Settings'
        })
        
        // Work duration setting
        new Setting(containerEl)
            .setName('Work Duration')
            .setDesc('How long (in minutes) you want to focus on your work.')
            .addSlider((slider) => {
                slider.setLimits(1, 60, 1)
                slider.setValue(this._settings.workLen)
                slider.onChange((value) => {
                    this.updateSettings({ workLen: value })
                })
                slider.setDynamicTooltip()
            })

        // Break duration setting
        new Setting(containerEl)
            .setName('Break Duration')
            .setDesc('How long (in minutes) you want to take a break. Set to 0 to disable break sessions.')
            .addSlider((slider) => {
                slider.setLimits(0, 30, 1)
                slider.setValue(this._settings.breakLen)
                slider.onChange((value) => {
                    this.updateSettings({ breakLen: value })
                })
                slider.setDynamicTooltip()
            })

        // Auto-start timer setting
        new Setting(containerEl)
            .setName('Auto-start Timer')
            .setDesc('Automatically start the next session after the current one finishes.')
            .addToggle((toggle) => {
                toggle.setValue(this._settings.autostart)
                toggle.onChange((value) => {
                    this.updateSettings({ autostart: value })
                })
            })

        // Status bar timer setting
        new Setting(containerEl)
            .setName('Show Timer in Status Bar')
            .setDesc('Display the timer in Obsidian\'s status bar.')
            .addToggle((toggle) => {
                toggle.setValue(this._settings.useStatusBarTimer)
                toggle.onChange((value) => {
                    this.updateSettings({ useStatusBarTimer: value }, true)
                })
            })

        // Low FPS mode setting
        new Setting(containerEl)
            .setName('Low FPS Mode')
            .setDesc('Reduce animation updates to save battery. Useful for mobile devices.')
            .addToggle((toggle) => {
                toggle.setValue(this._settings.lowFps)
                toggle.onChange((value) => {
                    this.updateSettings({ lowFps: value })
                })
            })

        /* ========== Task Settings ========== */
        
        section.createEl('h3', {
            text: 'Task Settings'
        })

        // Show task progress setting
        new Setting(containerEl)
            .setName('Show Task Progress')
            .setDesc('Display progress in the timer view when a task is being tracked.')
            .addToggle((toggle) => {
                toggle.setValue(this._settings.showTaskProgress)
                toggle.onChange((value) => {
                    this.updateSettings({ showTaskProgress: value })
                })
            })

        // Enable task tracking setting
        new Setting(containerEl)
            .setName('Enable Task Tracking')
            .setDesc('Update the pomodoro count in tasks when work sessions are completed.')
            .addToggle((toggle) => {
                toggle.setValue(this._settings.enableTaskTracking)
                toggle.onChange((value) => {
                    this.updateSettings({ enableTaskTracking: value })
                })
            })

        // Task format setting
        new Setting(containerEl)
            .setName('Task Format')
            .setDesc('Choose the format for tracking tasks.')
            .addDropdown((dropdown) => {
                dropdown.selectEl.style.width = '160px'
                dropdown.addOptions({
                    TASKS: 'Tasks Plugin',
                    TODO: 'Todo',
                })
                dropdown.setValue(this._settings.taskFormat)
                dropdown.onChange((value) => {
                    this.updateSettings(
                        { taskFormat: value as TaskFormat },
                        true,
                    )
                })
            })

        // Task query setting
        new Setting(containerEl)
            .setName('Task Query')
            .setDesc('Dataview query to fetch tasks for the timer. Requires the Dataview plugin.')
            .addTextArea((text) => {
                text.inputEl.style.width = '100%'
                text.inputEl.style.height = '5em'
                text.setValue(this._settings.taskQuery)
                text.onChange((value) => {
                    this.updateSettings({ taskQuery: value })
                })
            })

        /* ========== Notification Settings ========== */
        
        section.createEl('h3', {
            text: 'Notification Settings'
        })

        // Sound notification setting
        new Setting(containerEl)
            .setName('Sound Notification')
            .setDesc('Play a sound when a session ends.')
            .addToggle((toggle) => {
                toggle.setValue(this._settings.notificationSound)
                toggle.onChange((value) => {
                    this.updateSettings({ notificationSound: value })
                })
            })

        // Custom sound setting
        new Setting(containerEl)
            .setName('Custom Sound')
            .setDesc('Specify the path to a custom sound file in your vault.')
            .addText((text) => {
                text.setValue(this._settings.customSound)
                text.onChange((value) => {
                    this.updateSettings({ customSound: value })
                })
            })
            .addButton((button) => {
                button.setIcon('play-audio')
                button.onClick(() => {
                    this.plugin.timer!.playAudio()
                })
            })

        // System notification setting
        new Setting(containerEl)
            .setName('Use System Notification')
            .setDesc('Use the system\'s notification system instead of Obsidian\'s.')
            .addToggle((toggle) => {
                toggle.setValue(this._settings.useSystemNotification)
                toggle.onChange((value) => {
                    this.updateSettings({ useSystemNotification: value })
                })
            })

        /* ========== Logging Settings ========== */
        
        section.createEl('h3', {
            text: 'Logging Settings'
        })

        // Log file setting
        new Setting(containerEl)
            .setName('Log File')
            .setDesc('Choose where to log your completed Pomodoro sessions.')
            .addDropdown((dropdown) => {
                dropdown.selectEl.style.width = '160px'
                dropdown.addOptions({
                    NONE: 'None',
                    DAILY: 'Daily Note',
                    WEEKLY: 'Weekly Note',
                    FILE: 'Custom File',
                })
                dropdown.setValue(this._settings.logFile)
                dropdown.onChange((value) => {
                    this.updateSettings({ logFile: value as LogFileType }, true)
                })
            })

        // Log focused setting
        new Setting(containerEl)
            .setName('Log to Focused Task File')
            .setDesc('Log sessions to the file containing the focused task first, if available.')
            .addToggle((toggle) => {
                toggle.setValue(this._settings.logFocused)
                toggle.onChange((value) => {
                    this.updateSettings({ logFocused: value })
                })
            })

        // Log path setting
        if (this._settings.logFile === 'FILE') {
            new Setting(containerEl)
                .setName('Log Path')
                .setDesc('The path to the custom log file (relative to your vault).')
                .addText((text) => {
                    text.setValue(this._settings.logPath)
                    text.onChange((value) => {
                        this.updateSettings({ logPath: value })
                    })
                })
        }

        // Log level setting
        new Setting(containerEl)
            .setName('Log Level')
            .setDesc('Choose what types of sessions to log.')
            .addDropdown((dropdown) => {
                dropdown.selectEl.style.width = '160px'
                dropdown.addOptions({
                    ALL: 'All',
                    WORK: 'Work Only',
                    BREAK: 'Break Only',
                })
                dropdown.setValue(this._settings.logLevel)
                dropdown.onChange((value) => {
                    this.updateSettings({ logLevel: value as LogLevel })
                })
            })

        // Log format setting
        let example = ''
            
        // Sample task name for examples
        const sampleTaskName = "Sample task";
            
        if (this._settings.logFormat == 'SIMPLE') {
            const beginTime = moment().subtract(25, 'minutes');
            const endTime = moment();
            example = `- 🍅 \`WORK 25 minutes ${beginTime.format('YYYY-MM-DD HH:mm')} - ${endTime.format('YYYY-MM-DD HH:mm')}\``
        }
        if (this._settings.logFormat == 'VERBOSE') {
            const beginTime = moment().subtract(25, 'minutes');
            const endTime = moment();
            const content = `${beginTime.format('YYYY-MM-DD')} | task:: ${sampleTaskName} | mode:: WORK | duration:: 25m | time:: ${beginTime.format('YYYY-MM-DD HH:mm')} to ${endTime.format('HH:mm')}`;
            example = `- 🍅 \`${content}\``;
        }
        new Setting(containerEl)
            .setName('Log Format')
            .setDesc(example)
            .addDropdown((dropdown) => {
                dropdown.selectEl.style.width = '160px'
                dropdown.addOptions({
                    SIMPLE: 'Simple',
                    VERBOSE: 'Verbose',
                    CUSTOM: 'Custom',
                })
                dropdown.setValue(this._settings.logFormat)

                dropdown.onChange((value: string) => {
                    this.updateSettings(
                        { logFormat: value as LogFormat },
                        true,
                    )
                })
            })

        // Custom log template setting
        if (this._settings.logFormat === 'CUSTOM') {
            new Setting(containerEl)
                .setName('Log Template')
                .setDesc('Requires the Templater plugin.')
                .addTextArea((text) => {
                    text.inputEl.style.width = '100%'
                    text.inputEl.style.height = '5em'
                    text.setValue(this._settings.logTemplate)
                    text.onChange((value) => {
                        this.updateSettings({ logTemplate: value })
                    })
                })
        }

        new Setting(containerEl).addButton((button) => {
            button.setButtonText('Restore Settings')
            button.onClick(() => {
                this.updateSettings(PomodoroSettings.DEFAULT_SETTINGS, true)
            })
        })
    }
}

