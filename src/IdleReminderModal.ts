// src/IdleReminderModal.ts
import { Modal } from 'obsidian'
import type PomodoroTimerPlugin from 'main'
import { AsanaTaskModal } from './AsanaTaskModal'

export class IdleReminderModal extends Modal {
    private plugin: PomodoroTimerPlugin

    constructor(plugin: PomodoroTimerPlugin) {
        super(plugin.app)
        this.plugin = plugin
    }

    onOpen() {
        const { contentEl, modalEl } = this

        // Make modal larger and more attention-grabbing
        modalEl.addClass('idle-reminder-modal')
        modalEl.style.width = '500px'
        modalEl.style.maxWidth = '90vw'

        // Container with padding
        const container = contentEl.createDiv({ cls: 'idle-reminder-container' })
        container.style.textAlign = 'center'
        container.style.padding = '40px 20px'

        // Big tomato emoji
        const emoji = container.createEl('div', { text: '🍅' })
        emoji.style.fontSize = '80px'
        emoji.style.marginBottom = '20px'

        // Main message
        const title = container.createEl('h1', { text: 'No Timer Running!' })
        title.style.margin = '0 0 10px 0'
        title.style.fontSize = '28px'
        title.style.color = 'var(--text-error)'

        // Subtitle
        const subtitle = container.createEl('p', { text: 'What are you working on?' })
        subtitle.style.margin = '0 0 30px 0'
        subtitle.style.fontSize = '18px'
        subtitle.style.opacity = '0.8'

        // Button container
        const buttonContainer = container.createDiv({ cls: 'idle-reminder-buttons' })
        buttonContainer.style.display = 'flex'
        buttonContainer.style.gap = '15px'
        buttonContainer.style.justifyContent = 'center'
        buttonContainer.style.flexWrap = 'wrap'

        // Start Task button (primary)
        const startBtn = buttonContainer.createEl('button', { text: '▶ Select a Task' })
        startBtn.addClass('mod-cta')
        startBtn.style.fontSize = '16px'
        startBtn.style.padding = '12px 24px'
        startBtn.addEventListener('click', () => {
            this.close()
            new AsanaTaskModal(this.plugin).open()
        })

        // Dismiss button (secondary)
        const dismissBtn = buttonContainer.createEl('button', { text: 'Dismiss (5 min)' })
        dismissBtn.style.fontSize = '14px'
        dismissBtn.style.padding = '10px 20px'
        dismissBtn.addEventListener('click', () => {
            this.close()
        })

        // Snooze info
        const snoozeInfo = container.createEl('p', {
            text: 'Reminder will return in 5 minutes if no timer started'
        })
        snoozeInfo.style.marginTop = '25px'
        snoozeInfo.style.fontSize = '12px'
        snoozeInfo.style.opacity = '0.5'

        // Focus the start button
        startBtn.focus()
    }

    onClose() {
        const { contentEl } = this
        contentEl.empty()
    }
}
