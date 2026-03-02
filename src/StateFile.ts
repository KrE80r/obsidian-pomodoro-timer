// src/StateFile.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface TimerState {
    active: boolean;
    task_id?: string;
    task_text?: string;
    asana_url?: string;
    customer?: string;
    tag?: string;
    started_at?: string;
    duration_minutes?: number;
}

export class StateFile {
    private stateFilePath: string;

    constructor() {
        const stateDir = path.join(os.homedir(), '.local', 'share', 'time-tracker');
        this.stateFilePath = path.join(stateDir, 'state.json');
    }

    read(): TimerState {
        try {
            if (fs.existsSync(this.stateFilePath)) {
                const content = fs.readFileSync(this.stateFilePath, 'utf-8');
                return JSON.parse(content);
            }
        } catch (e) {
            console.error('Failed to read state file:', e);
        }
        return { active: false };
    }

    write(state: TimerState): void {
        try {
            const dir = path.dirname(this.stateFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2));
        } catch (e) {
            console.error('Failed to write state file:', e);
        }
    }

    update(updates: Partial<TimerState>): void {
        const current = this.read();
        this.write({ ...current, ...updates });
    }
}
