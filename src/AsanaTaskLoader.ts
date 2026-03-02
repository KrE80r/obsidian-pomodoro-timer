// src/AsanaTaskLoader.ts
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export interface AsanaTask {
    text: string
    asana_url?: string
    customer: string
    tag: string
    status?: string
}

export class AsanaTaskLoader {
    private tasksFilePath: string

    constructor() {
        const dataDir = path.join(os.homedir(), '.local', 'share', 'time-tracker')
        this.tasksFilePath = path.join(dataDir, 'tasks.json')
    }

    /**
     * Load tasks from the Asana Bridge tasks.json file
     */
    load(): AsanaTask[] {
        try {
            if (fs.existsSync(this.tasksFilePath)) {
                const content = fs.readFileSync(this.tasksFilePath, 'utf-8')
                const tasks = JSON.parse(content) as AsanaTask[]
                return tasks
            }
        } catch (e) {
            console.error('Failed to load Asana tasks:', e)
        }
        return []
    }

    /**
     * Format task label for display: "CBA Move to cloud #cba"
     * This format flows through to daily note entries
     */
    static formatLabel(task: AsanaTask): string {
        return `${task.customer} ${task.text} ${task.tag}`
    }

    /**
     * Get customer badge color for UI display
     */
    static getCustomerColor(customer: string): string {
        const colors: Record<string, string> = {
            'CBA': '#FFD700',      // Gold
            'Qantas': '#E31837',   // Qantas red
            'Kiwi': '#00A651',     // Green
            'BNZ': '#1D2C5E',      // BNZ blue
        }
        return colors[customer] || '#888888'
    }
}
