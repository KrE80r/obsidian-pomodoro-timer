import { type TimerState, type Mode } from 'Timer'
import * as utils from 'utils'
import PomodoroTimerPlugin from 'main'
import { TFile, Notice, moment } from 'obsidian'
import { type TaskItem } from 'Tasks'

export type TimerLog = {
    duration: number
    begin: number
    end: number
    mode: Mode
    session: number
    task: TaskLog
    finished: boolean
}

export type TaskLog = Pick<
    TaskItem,
    | 'fileName'
    | 'path'
    | 'name'
    | 'text'
    | 'description'
    | 'blockLink'
    | 'actual'
    | 'expected'
    | 'status'
    | 'checked'
    | 'created'
    | 'start'
    | 'scheduled'
    | 'due'
    | 'done'
    | 'cancelled'
    | 'priority'
    | 'recurrence'
    | 'tags'
>

export type LogContext = TimerState & { task: TaskItem }

export default class Logger {
    private plugin: PomodoroTimerPlugin

    constructor(plugin: PomodoroTimerPlugin) {
        this.plugin = plugin
    }

    public async log(ctx: LogContext): Promise<TFile | void> {
        const logFile = await this.resolveLogFile(ctx)
        const log = this.createLog(ctx)
        if (logFile) {
            const logText = await this.toText(log, logFile)
            if (logText) {
                await this.insertUnderSection(logFile, logText, 'Pomodoro')
            }
        }

        return logFile
    }

    /**
     * Insert text under a specific section heading, or append to end if not found
     */
    private async insertUnderSection(file: TFile, text: string, sectionName: string): Promise<void> {
        const content = await this.plugin.app.vault.read(file)
        const lines = content.split('\n')

        // Find the section heading (## Pomodoro or # Pomodoro)
        const sectionRegex = new RegExp(`^#{1,3}\\s+${sectionName}\\s*$`, 'i')
        let sectionIndex = -1

        for (let i = 0; i < lines.length; i++) {
            if (sectionRegex.test(lines[i])) {
                sectionIndex = i
                break
            }
        }

        if (sectionIndex === -1) {
            // Section not found, just append to end
            await this.plugin.app.vault.append(file, `\n${text}`)
            return
        }

        // Find the end of the section (next heading or end of file)
        let insertIndex = sectionIndex + 1

        // Skip any blank lines right after the heading
        while (insertIndex < lines.length && lines[insertIndex].trim() === '') {
            insertIndex++
        }

        // Find where to insert (after existing content in section, before next heading)
        let endOfSection = lines.length
        for (let i = insertIndex; i < lines.length; i++) {
            if (/^#{1,3}\s+/.test(lines[i])) {
                // Found next heading
                endOfSection = i
                break
            }
        }

        // Insert at the end of the section (just before the next heading or EOF)
        // But after any existing pomodoro entries
        lines.splice(endOfSection, 0, text)

        await this.plugin.app.vault.modify(file, lines.join('\n'))
    }

    private async resolveLogFile(ctx: LogContext): Promise<TFile | void> {
        const settings = this.plugin!.getSettings()

        // filter log level
        if (settings.logLevel !== 'ALL' && settings.logLevel !== ctx.mode) {
            return
        }

        // focused file has the highest priority
        if (
            settings.logFocused &&
            ctx.task.path &&
            ctx.task.path.endsWith('md')
        ) {
            const file = this.plugin.app.vault.getAbstractFileByPath(
                ctx.task.path,
            )
            if (file && file instanceof TFile) {
                return file
            }
            // fall-through
        }

        if (settings.logFile === 'NONE') {
            return
        }

        // use daily note
        if (settings.logFile === 'DAILY') {
            return await utils.getDailyNoteFile()
        }

        // use weekly note
        if (settings.logFile == 'WEEKLY') {
            return await utils.getWeeklyNoteFile()
        }

        // log to file
        if (settings.logFile === 'FILE') {
            if (settings.logPath) {
                let path = settings.logPath
                if (!path.endsWith('md')) {
                    path += '.md'
                }
                try {
                    return await utils.ensureFileExists(this.plugin.app, path)
                } catch (error) {
                    if (error instanceof Error) {
                        new Notice(error.message)
                    }
                    return
                }
            }
        }
    }

    private createLog(ctx: LogContext): TimerLog {
        return {
            mode: ctx.mode,
            duration: Math.floor(ctx.elapsed / 60000),
            begin: ctx.startTime!,
            end: new Date().getTime(),
            session: ctx.duration,
            task: ctx.task,
            finished: ctx.count == ctx.elapsed,
        }
    }

    private async toText(log: TimerLog, file: TFile): Promise<string> {
        const settings = this.plugin.getSettings()
        if (
            settings.logFormat === 'CUSTOM' &&
            utils.getTemplater(this.plugin.app)
        ) {
            // use templater
            try {
                return await utils.parseWithTemplater(
                    this.plugin.app,
                    file,
                    settings.logTemplate,
                    log,
                )
            } catch (e) {
                new Notice('Invalid template')
                console.error('invalid templat:', e)
                return ''
            }
        } else {
            // Built-in log: ignore unfinished session
            if (!log.finished) {
                return ''
            }

            let begin = moment(log.begin)
            let end = moment(log.end)
            
            // Get task name if available for WORK mode, extract display text from wiki links
            // Inline the extraction logic to avoid module resolution issues
            let taskName = '';
            if (log.mode === 'WORK' && log.task) {
                // Try name first, then description, then text
                const rawTaskName = log.task.name || log.task.description || log.task.text || '';
                
                // Inline wiki link extraction to ensure it always works
                if (rawTaskName) {
                    // Check if the text contains wiki links
                    if (!rawTaskName.includes('[[')) {
                        taskName = rawTaskName.trim();
                    } else {
                        // Regex to match wiki links: [[path|display]] or [[path]]
                        const wikiLinkRegex = /\[\[([^\]]+?)(?:\|([^\]]+?))?\]\]/g;
                        
                        // Replace all wiki links with their display text
                        taskName = rawTaskName.replace(wikiLinkRegex, (match, path, display) => {
                            // If there's a display text (after |), use it
                            if (display) {
                                return display;
                            }
                            // Otherwise, extract just the note name from the path
                            const parts = path.split('/');
                            return parts[parts.length - 1];
                        }).trim();
                    }
                }
            }
                
            if (settings.logFormat === 'SIMPLE') {
                // Format to match the screenshot style
                return `- 🍅 \`${log.mode} ${log.duration} minute${log.duration !== 1 ? 's' : ''} ${begin.format(
                    'YYYY-MM-DD HH:mm',
                )} - ${end.format('YYYY-MM-DD HH:mm')}\``
            }

            if (settings.logFormat === 'VERBOSE') {
                const emoji = log.mode == 'WORK' ? '🍅' : '🥤'
                
                if (log.mode === 'WORK' && taskName) {
                    // Create content for code block with Dataview fields but without the tick mark
                    const content = `${begin.format('YYYY-MM-DD')} | task:: ${taskName} | mode:: ${log.mode} | duration:: ${log.duration}m | time:: ${begin.format('YYYY-MM-DD HH:mm')} to ${end.format('HH:mm')}`;
                    // Return format with highlighted background (code block) and no check mark
                    return `- ${emoji} \`${content}\``;
                } else if (log.mode === 'WORK') {
                    // Generic work session format
                    return `- ${emoji} \`${log.mode} ${log.duration} minute${log.duration !== 1 ? 's' : ''} ${begin.format('YYYY-MM-DD HH:mm')} - ${end.format('YYYY-MM-DD HH:mm')}\``;
                } else {
                    // Break session format
                    return `- ${emoji} \`${log.mode} ${log.duration} minute${log.duration !== 1 ? 's' : ''} ${begin.format('YYYY-MM-DD HH:mm')} - ${end.format('YYYY-MM-DD HH:mm')}\``;
                }
            }

            return ''
        }
    }
}
