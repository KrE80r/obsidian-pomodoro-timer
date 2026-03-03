<h1 align="center">Pomodoro Timer for Obsidian</h1>

![image](https://github.com/eatgrass/obsidian-pomodoro-timer/assets/2351076/f2f4f339-ba66-423f-b6a5-79fe91e13ef0)

## Introduction

This plugin integrates a customizable Pomodoro timer into your Obsidian workspace, helping you focus and manage your time effectively.

## Features

-   **Customizable Timer**: Set your work and break intervals to suit your productivity style.
-   **Audible Alerts**: Stay on track with audio notifications signaling the end of each session.
-   **Status Bar Display**: Monitor your progress directly from Obsidian's status bar to keep focusing.
-   **Daily Note Integration**: Automatically log your sessions in your daily notes for better tracking.
-   **Task Tracking**: Automatically refresh the 'actual time' field for the task in focus.

## Notification

### Custom Notification Sound

1. Put the audio file into your vault.
2. Set its path ralative to the vault's root.
   For example: your audio file is in `AudioFiles` and named `notification.mp3`, your path would be `AudioFiles/notification.mp3`.
   **Don't forget the file extension (like `.mp3`, `.wav` etc.).**
3. Click the `play` button next to the path to verify the audio

## Task Tracking

To activate this feature, first enable it in the settings. Then add pomodoros inline-field after your task's text description as below. The pomodoro timer will then automatically update the actual count at the end of each work session.

**Important: Ensure to add this inline-field before the [Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) plugin's fields. Placing it elsewhere may result in incorrect rendering within the Tasks Plugin.**

```markdown
-   [ ] Task with specified expected and actual pomodoros fields [🍅:: 3/10]
-   [ ] Task with only the actual pomodoros field [🍅:: 5]
-   [ ] With Task plugin enabled [🍅:: 5] ➕ 2023-12-29 📅 2024-01-10
```

## Log

### Log Format

The standard log formats are as follows
For those requiring more detailed logging, consider setting up a custom [log template](#Custom Log Template) as described below.

**Simple**

```
**WORK(25m)**: 20:16 - 20:17
**BREAK(25m)**: 20:16 - 20:17
```

**Verbose**

```plain
- 🍅 (pomodoro::WORK) (duration:: 25m) (begin:: 2023-12-20 15:57) - (end:: 2023-12-20 15:58)
- 🥤 (pomodoro::BREAK) (duration:: 25m) (begin:: 2023-12-20 16:06) - (end:: 2023-12-20 16:07)
```

### Custom Log Template (Optional)

1. Install the [Templater](https://github.com/SilentVoid13/Templater) plugin.
2. Compose your log template script using the `log` object, which stores session information.

```javascript
// TimerLog
{
    duration: number,  // duratin in minutes
    session: number,   // session length
    finished: boolean, // if the session is finished?
    mode: string,      // 'WORK' or 'BREAK'
    begin: Moment,     // start time
    end: Moment,       // end time
    task: TaskItem,    // focused task
}

// TaskItem
{
    path: string,         // task file path
    fileName: string,     // task file name
    text: string,         // the full text of the task
    name: string,         // editable task name (default: task description)
    status: string,       // task checkbox symbol
    blockLink: string,    // block link id of the task
    checked: boolean,     // if the task's checkbox checked
    done: string,         // done date
    due: string,          // due date
    created: string,      // created date
    cancelled: string,    // cancelled date
    scheduled: string,    // scheduled date
    start: string,        // start date
    description: string,  // task description
    priority: string,     // task priority
    recurrence: string,   // task recurrence rule
    tags: string[],       // task tags
	expected: number,     // expected pomodoros
	actual: number        // actual pomodoros
}
```

here is an example

```javascript
<%*
if (log.mode == "WORK") {
  if (!log.finished) {
    tR = `🟡 Focused ${log.task.name} ${log.duration} / ${log.session} minutes`;
  } else {
    tR = `🍅 Focused ${log.task.name} ${log.duration} minutes`;
  }
} else {
  tR = `☕️ Took a break from ${log.begin.format("HH:mm")} to ${log.end.format(
    "HH:mm"
  )}`;
}
%>
```

## Examples of Using with DataView

### Log Table

This DataView script generates a table showing Pomodoro sessions with their durations, start, and end times.

![image](https://github.com/eatgrass/obsidian-pomodoro-timer/assets/2351076/ebcf33ac-291e-4659-ab03-93bfbe1c79d3)

<pre>
```dataviewjs
const pages = dv.pages()
const table = dv.markdownTable(['Pomodoro','Duration', 'Begin', 'End'],
pages.file.lists
.filter(item=>item.pomodoro)
.sort(item => item.end, 'desc')
.map(item=> {

    return [item.pomodoro, `${item.duration.as('minutes')} m`, item.begin, item.end]
})
)
dv.paragraph(table)

```  
</pre>

### Summary View

This DataView script presents a summary of Pomodoro sessions, categorized by date.

![image](https://github.com/eatgrass/obsidian-pomodoro-timer/assets/2351076/84119bb0-c78e-4716-9a76-ffa72d94a587)

<pre>
```dataviewjs
const pages = dv.pages();
const emoji = "🍅";
dv.table(
  ["Date", "Pomodoros", "Total"],
  pages.file.lists
    .filter((item) => item?.pomodoro == "WORK")
    .groupBy((item) => {
      if (item.end && item.end.length >= 10) {
        return item.end.substring(0, 10);
      } else {
        return "Unknown Date";
      }
    })
    .map((group) => {
      let sum = 0;
      group.rows.forEach((row) => (sum += row.duration.as("minutes")));
      return [
        group.key,
        group.rows.length > 5
          ? `${emoji}  ${group.rows.length}`
          : `${emoji.repeat(group.rows.length)}`,
        `${sum} min`,
      ];
    })
)
```
</pre>

## CSS Variables

| Variable                       | Default            |
| ------------------------------ | ------------------ |
| --pomodoro-timer-color         | var(--text-faint)  |
| --pomodoro-timer-elapsed-color | var(--color-green) |
| --pomodoro-timer-text-color    | var(--text-normal) |
| --pomodoro-timer-dot-color     | var(--color-ted)   |

## Idle Reminder System

The plugin includes an intelligent idle reminder system that prompts you to start a timer when you're not actively tracking work.

### Features

- **Periodic Reminders**: Checks every 5 minutes during configured work hours
- **Smart Detection**: Only shows reminders when:
  - Reminder is enabled in settings
  - It's a weekday (Mon-Fri)
  - Current time is within work hours
  - No timer is currently running
  - You're not in a video meeting (Zoom/Teams/Meet)
- **Native Popup**: Cross-platform Python/Tkinter popup that appears on your active monitor
- **Task Search**: Filter tasks by typing in the search box
- **Color-Coded Badges**: Customer tags displayed with distinct colors (CBA=red, Qantas=purple, etc.)
- **New Task Creation**: Create ad-hoc tasks directly from the popup, optionally synced to Asana
- **Dataview Integration**: Tasks are refreshed from your Dataview query each time the reminder appears

### Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Enable Idle Reminder | Toggle the reminder system | On |
| Work Hours Start | Hour when reminders begin | 9:00 |
| Work Hours End | Hour when reminders stop | 18:00 |

### Task Query

Configure a Dataview query in settings to load your tasks:

```
TASK FROM "0-Daily notes"
WHERE !completed
```

### Architecture

The idle reminder uses two components:

1. **Obsidian Plugin** (`src/IdleReminderWindow.ts`): Manages the reminder schedule, refreshes tasks, and handles timer activation
2. **Python Popup** (`scripts/idle-reminder-popup.py`): Native GUI with search, task selection, and Asana integration

### Asana Integration

If you have the [Obsidian Asana Bridge](https://github.com/your-repo/obsidian-asana-bridge) plugin configured, new tasks created from the popup can be automatically synced to Asana with proper project assignment.

### Data Files

The system uses `~/.local/share/time-tracker/` for:
- `tasks.json` - Exported task list for the popup
- `popup-result.json` - Selected task result
- `state.json` - Timer state for external integrations

---

## FAQ

1. How to Switch the Session

To switch sessions, simply click on the `Work/Break` label displayed on the timer.

2. How to completely disable `Break` sessions

You can adjust the break interval setting to `0`, this will turn off `Break` sessions.

---

[<img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="BuyMeACoffee" width="150">](https://www.buymeacoffee.com/eatgrass)
