import PomodoroTimerPlugin from 'main'
// @ts-ignore
import Worker from 'clock.worker'
import { writable, derived } from 'svelte/store'
import type { Readable } from 'svelte/store'
import { Notice, TFile } from 'obsidian'
import Logger, { type LogContext } from 'Logger'
import DEFAULT_NOTIFICATION from 'Notification'
import type { Unsubscriber } from 'svelte/motion'
import type { TaskItem } from 'Tasks'

export type Mode = 'WORK' | 'BREAK'

export type TimerRemained = {
    millis: number
    human: string
}

const DEFAULT_TASK: TaskItem = {
    actual: 0,
    expected: 0,
    path: '',
    fileName: '',
    text: '',
    name: '',
    status: '',
    blockLink: '',
    checked: false,
    done: '',
    due: '',
    created: '',
    cancelled: '',
    scheduled: '',
    start: '',
    description: '',
    priority: '',
    recurrence: '',
    tags: [],
    line: -1,
}

export type TimerState = {
    autostart: boolean
    running: boolean
    // lastTick: number
    mode: Mode
    elapsed: number
    startTime: number | null
    inSession: boolean
    workLen: number
    breakLen: number
    count: number
    duration: number
}

export type TimerStore = TimerState & {
    remained: TimerRemained
    finished: boolean
}

export default class Timer implements Readable<TimerStore> {
    static DEFAULT_NOTIFICATION_AUDIO = new Audio(DEFAULT_NOTIFICATION)

    private plugin: PomodoroTimerPlugin

    private logger: Logger

    private state: TimerState

    private store: Readable<TimerStore>

    private clock: any

    private update

    private unsubscribers: Unsubscriber[] = []

    public subscribe

    constructor(plugin: PomodoroTimerPlugin) {
        this.plugin = plugin
        this.logger = new Logger(plugin)
        
        // Always start in WORK mode regardless of what was saved
        // This ensures we don't continue in BREAK mode from a previous day
        const initialMode: Mode = 'WORK';
        
        let count = this.toMillis(plugin.getSettings().workLen)
        this.state = {
            autostart: plugin.getSettings().autostart,
            workLen: plugin.getSettings().workLen,
            breakLen: plugin.getSettings().breakLen,
            running: false,
            // lastTick: 0,
            mode: initialMode, // Always use WORK mode on startup
            elapsed: 0,
            startTime: null,
            inSession: false,
            duration: plugin.getSettings().workLen, // Always use workLen for duration on startup
            count: count, // Always use work count on startup
        }

        let store = writable(this.state)

        this.update = store.update

        this.store = derived(store, ($state) => ({
            ...$state,
            remained: this.remain($state.count, $state.elapsed),
            finished: $state.count == $state.elapsed,
        }))

        this.subscribe = this.store.subscribe
        this.unsubscribers.push(
            this.store.subscribe((state) => {
                this.state = state
            }),
        )
        this.clock = Worker()
        this.clock.onmessage = ({ data }: any) => {
            this.tick(data as number)
        }
    }

    private remain(count: number, elapsed: number): TimerRemained {
        let remained = count - elapsed
        let min = Math.floor(remained / 60000)
        let sec = Math.floor((remained % 60000) / 1000)
        let minStr = min < 10 ? `0${min}` : min.toString()
        let secStr = sec < 10 ? `0${sec}` : sec.toString()
        return {
            millis: remained,
            human: `${minStr} : ${secStr}`,
        }
    }

    private toMillis(minutes: number) {
        return minutes * 60 * 1000
    }

    private tick(t: number) {
        let timeup: boolean = false
        let pause: boolean = false
        this.update((s) => {
            if (s.running) {
                s.elapsed += t
                if (s.elapsed >= s.count) {
                    s.elapsed = s.count
                }
                timeup = s.elapsed >= s.count
            } else {
                pause = true
            }
            return s
        })
        if (!pause && timeup) {
            this.timeup()
        }
    }

    private timeup() {
        let autostart = false
        this.update((state) => {
            const ctx = this.createLogContext(state)
            this.processLog(ctx)
            autostart = state.autostart
            return this.endSession(state)
        })
        
        // Force a store update to trigger a UI refresh
        // This is a cleaner approach than temporarily modifying elapsed
        this.update(state => ({ ...state }))
        
        if (autostart) {
            setTimeout(() => {
                this.start()
            }, 100)
        }
    }

    private createLogContext(s: TimerState): LogContext {
        let state = { ...s }
        let task = this.plugin.tracker?.task
            ? { ...this.plugin.tracker.task }
            : { ...DEFAULT_TASK }

        if (!task.path) {
            task.path = this.plugin.tracker?.file?.path ?? ''
            task.fileName = this.plugin.tracker?.file?.name ?? ''
        }

        return { ...state, task }
    }

    private async processLog(ctx: LogContext) {
        if (ctx.mode == 'WORK') {
            // Use the robust method for handling task updates regardless of active file
            if (this.plugin.tasks) {
                console.log('Using robust task update method to increment pomodoro count');
                this.plugin.tasks.updateActiveTaskPomodoroCount();
            }
        }
        const logFile = await this.logger.log(ctx)
        this.notify(ctx, logFile)
    }

    public start() {
        this.update((s) => {
            let now = new Date().getTime()
            if (!s.inSession) {
                // new session
                s.elapsed = 0
                s.duration = s.mode === 'WORK' ? s.workLen : s.breakLen
                s.count = s.duration * 60 * 1000
                s.startTime = now
            }
            s.inSession = true
            s.running = true
            this.clock.postMessage({
                start: true,
                lowFps: this.plugin.getSettings().lowFps,
            })
            return s
        })
    }

    private endSession(state: TimerState) {
        // setup new session
        if (state.breakLen == 0) {
            state.mode = 'WORK'
        } else {
            state.mode = state.mode == 'WORK' ? 'BREAK' : 'WORK'
        }
        
        // Save the new mode to localStorage - this only affects the current session
        // On startup, we'll always reset to WORK mode regardless of this value
        this.saveCurrentMode(state.mode);
        
        state.duration = state.mode == 'WORK' ? state.workLen : state.breakLen
        state.count = state.duration * 60 * 1000
        state.inSession = false
        state.running = false
        this.clock.postMessage({
            start: false,
            lowFps: this.plugin.getSettings().lowFps,
        })
        state.startTime = null
        state.elapsed = 0
        return state
    }

    private notify(state: TimerState, logFile: TFile | void) {
        const emoji = state.mode == 'WORK' ? '🍅' : '🥤'
        const text = `${emoji} You have been ${
            state.mode === 'WORK' ? 'working' : 'breaking'
        } for ${state.duration} minutes.`

        if (this.plugin.getSettings().useSystemNotification) {
            const Notification = (require('electron') as any).remote
                .Notification
            const sysNotification = new Notification({
                title: 'Pomodoro Timer',
                body: text,
                silent: true,
            })
            sysNotification.on('click', () => {
                if (logFile) {
                    this.plugin.app.workspace.getLeaf('split').openFile(logFile)
                }
                sysNotification.close()
            })
            sysNotification.show()
        } else {
            let fragment = new DocumentFragment()
            let span = fragment.createEl('span')
            span.setText(`${text}`)
            fragment.addEventListener('click', () => {
                if (logFile) {
                    this.plugin.app.workspace.getLeaf('split').openFile(logFile)
                }
            })
            new Notice(fragment)
        }

        if (this.plugin.getSettings().notificationSound) {
            this.playAudio()
        }
    }

    public pause() {
        this.update((state) => {
            state.running = false
            this.clock.postMessage({
                start: false,
                lowFps: this.plugin.getSettings().lowFps,
            })
            return state
        })
    }

    public reset() {
        this.update((state) => {
            if (state.elapsed > 0) {
                this.logger.log(this.createLogContext(state))
            }

            state.duration =
                state.mode == 'WORK' ? state.workLen : state.breakLen
            state.count = state.duration * 60 * 1000
            state.inSession = false
            state.running = false

            if (!this.plugin.tracker!.pinned) {
                this.plugin.tracker!.clear()
            }
            this.clock.postMessage({
                start: false,
                lowFps: this.plugin.getSettings().lowFps,
            })
            state.startTime = null
            state.elapsed = 0
            return state
        })
    }

    public toggleMode(callback?: (state: TimerState) => void) {
        this.update((s) => {
            let updated = this.endSession(s);
            
            // Save the new mode
            this.saveCurrentMode(updated.mode);
            
            if (callback) {
                callback(updated)
            }
            return updated
        })
    }

    public toggleTimer() {
        this.state.running ? this.pause() : this.start()
    }

    public playAudio() {
        let audio = Timer.DEFAULT_NOTIFICATION_AUDIO
        let customSound = this.plugin.getSettings().customSound
        if (customSound) {
            const soundFile =
                this.plugin.app.vault.getAbstractFileByPath(customSound)
            if (soundFile && soundFile instanceof TFile) {
                const soundSrc =
                    this.plugin.app.vault.getResourcePath(soundFile)
                audio = new Audio(soundSrc)
            }
        }
        audio.play()
    }

    public setupTimer() {
        this.update((state) => {
            const { workLen, breakLen, autostart } = this.plugin.getSettings()
            state.workLen = workLen
            state.breakLen = breakLen
            state.autostart = autostart
            if (!state.running && !state.inSession) {
                state.duration =
                    state.mode == 'WORK' ? state.workLen : state.breakLen
                state.count = state.duration * 60 * 1000
            }

            return state
        })
    }

    public destroy() {
        this.pause()
        this.clock?.terminate()
        for (let unsub of this.unsubscribers) {
            unsub()
        }
    }

    public async endEarly() {
        // Only proceed if we're in a session
        if (!this.state.inSession) {
            return;
        }

        // Calculate actual elapsed time for the log
        const actualElapsed = this.state.elapsed;
        const actualDuration = Math.floor(actualElapsed / (60 * 1000)); // Convert to minutes

        // Create a log context with actual elapsed time and make it "finished"
        // by setting count = elapsed so the finished check in Logger.createLog passes
        const logContext = this.createLogContext({
            ...this.state,
            elapsed: actualElapsed,
            count: actualElapsed, // This makes it "finished" since count = elapsed
            duration: actualDuration
        });

        // Log the session with actual duration
        await this.processLog(logContext);

        // Update the state to end the session
        this.update((state) => {
            // Use the same session end logic as natural completion
            if (state.breakLen == 0) {
                state.mode = 'WORK';
            } else {
                state.mode = state.mode == 'WORK' ? 'BREAK' : 'WORK';
            }
            
            this.saveCurrentMode(state.mode);
            
            // Reset timer state
            state.duration = state.mode == 'WORK' ? state.workLen : state.breakLen;
            state.count = state.duration * 60 * 1000;
            state.inSession = false;
            state.running = false;
            this.clock.postMessage({
                start: false,
                lowFps: this.plugin.getSettings().lowFps,
            });
            state.startTime = null;
            state.elapsed = 0;
            
            return state;
        });
    }

    // Add a method to save the current mode
    private saveCurrentMode(mode: Mode) {
        // Save to localStorage for persistence within the current session
        // This won't affect the startup mode, which is always set to WORK
        localStorage.setItem('pomodoro-timer-mode', mode);
    }
}
