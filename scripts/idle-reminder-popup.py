#!/usr/bin/python3
"""
Idle Reminder Popup - A searchable task selector with color-coded customers
Shows on active monitor, allows searching and creating new tasks (including in Asana)
"""

import json
import os
import sys
import tkinter as tk
from tkinter import ttk
from pathlib import Path
import urllib.request
import urllib.error

# Customer color mapping
CUSTOMER_COLORS = {
    'CBA': '#e74c3c',      # Red
    'Qantas': '#9b59b6',   # Purple
    'Kiwi': '#2ecc71',     # Green
    'BNZ': '#3498db',      # Blue
    'Internal': '#95a5a6', # Gray
    'WP': '#e67e22',       # Orange
    'Westpac': '#d35400',  # Dark Orange
}

TASKS_FILE = Path.home() / '.local/share/time-tracker/tasks.json'
RESULT_FILE = Path.home() / '.local/share/time-tracker/popup-result.json'
ASANA_CONFIG = Path.home() / 'obsidian/.obsidian/plugins/obsidian-asana-bridge/data.json'
QUICK_TASKS_FILE = Path.home() / '.local/share/time-tracker/quick-tasks.json'

class AsanaAPI:
    """Simple Asana API client - compatible with obsidian-asana-bridge"""

    def __init__(self):
        self.config = self.load_config()
        self.token = self.config.get('asanaAccessToken', '') if self.config else ''
        self.projects = {p['prefix']: p for p in self.config.get('selectedProjects', [])} if self.config else {}
        self._token_owner = None

    def load_config(self):
        """Load Asana config from Obsidian plugin"""
        if not ASANA_CONFIG.exists():
            return None
        try:
            with open(ASANA_CONFIG) as f:
                return json.load(f)
        except:
            return None

    def get_token_owner(self) -> dict | None:
        """Get the user who owns the token (for assignee)"""
        if self._token_owner:
            return self._token_owner
        if not self.token:
            return None
        try:
            req = urllib.request.Request(
                'https://app.asana.com/api/1.0/users/me',
                headers={'Authorization': f'Bearer {self.token}'},
            )
            with urllib.request.urlopen(req, timeout=10) as response:
                result = json.loads(response.read().decode('utf-8'))
                self._token_owner = result.get('data', {})
                return self._token_owner
        except Exception as e:
            print(f"Failed to get token owner: {e}")
            return None

    def create_task(self, name: str, customer: str) -> dict | None:
        """Create a task in Asana and return task info with URL"""
        if not self.token:
            print("No Asana token configured")
            return None

        project = self.projects.get(customer)
        if not project:
            print(f"No Asana project configured for {customer}")
            return None

        project_id = project['id']
        section_id = project.get('defaultSectionId')

        # Get token owner for assignee (matches asana-bridge behavior)
        token_owner = self.get_token_owner()

        # Create task via API
        url = 'https://app.asana.com/api/1.0/tasks'
        data = {
            'data': {
                'name': name,
                'projects': [project_id],
            }
        }

        # Assign to token owner (like asana-bridge does)
        if token_owner and token_owner.get('gid'):
            data['data']['assignee'] = token_owner['gid']

        # Add to section if configured
        if section_id:
            data['data']['memberships'] = [{'project': project_id, 'section': section_id}]

        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(data).encode('utf-8'),
                headers={
                    'Authorization': f'Bearer {self.token}',
                    'Content-Type': 'application/json',
                },
                method='POST'
            )
            with urllib.request.urlopen(req, timeout=10) as response:
                result = json.loads(response.read().decode('utf-8'))
                task_data = result.get('data', {})
                gid = task_data.get('gid', '')
                permalink = task_data.get('permalink_url', '')

                # If no permalink, construct it
                if not permalink and gid:
                    permalink = f"https://app.asana.com/0/{project_id}/{gid}"

                return {
                    'gid': gid,
                    'name': name,
                    'permalink': permalink,
                }
        except urllib.error.HTTPError as e:
            print(f"Asana API error: {e.code} - {e.read().decode('utf-8')}")
            return None
        except Exception as e:
            print(f"Error creating Asana task: {e}")
            return None

    def get_customers(self) -> list[str]:
        """Get list of configured customers"""
        return list(self.projects.keys())


class IdleReminderPopup:
    def __init__(self):
        self.tasks = self.load_tasks()
        self.filtered_tasks = self.tasks.copy()
        self.selected_task = None
        self.asana = AsanaAPI()
        self.quick_tasks_config = self.load_quick_tasks()
        self.show_quick_tasks = False  # Toggle between quick tasks and full task list
        self.selected_customer = None  # For customer+template combinations

        # Create window
        self.root = tk.Tk()
        self.root.title("🍅 Focus Time")
        self.root.configure(bg='#0d1117')

        # Window size
        width, height = 520, 520

        # Get screen dimensions where mouse is located
        mouse_x = self.root.winfo_pointerx()
        mouse_y = self.root.winfo_pointery()

        # Get the screen containing the mouse
        # Use screenwidth/screenheight for the virtual screen, then find monitor
        screen_width = self.root.winfo_screenwidth()
        screen_height = self.root.winfo_screenheight()

        # For multi-monitor: try to get monitor info via xrandr
        try:
            import subprocess
            result = subprocess.run(['xrandr', '--query'], capture_output=True, text=True, timeout=2)
            monitors = []
            for line in result.stdout.split('\n'):
                if ' connected' in line and 'x' in line:
                    # Parse: "DP-1 connected primary 2560x1440+0+0"
                    parts = line.split()
                    for part in parts:
                        if 'x' in part and '+' in part:
                            # Format: WxH+X+Y
                            geom = part.split('+')
                            dims = geom[0].split('x')
                            if len(dims) == 2 and len(geom) >= 3:
                                monitors.append({
                                    'w': int(dims[0]),
                                    'h': int(dims[1]),
                                    'x': int(geom[1]),
                                    'y': int(geom[2])
                                })
                            break

            # Find which monitor contains the mouse
            for mon in monitors:
                if (mon['x'] <= mouse_x < mon['x'] + mon['w'] and
                    mon['y'] <= mouse_y < mon['y'] + mon['h']):
                    # Center on this monitor
                    x = mon['x'] + (mon['w'] - width) // 2
                    y = mon['y'] + (mon['h'] - height) // 2
                    break
            else:
                # Fallback: center on first monitor or screen
                if monitors:
                    x = monitors[0]['x'] + (monitors[0]['w'] - width) // 2
                    y = monitors[0]['y'] + (monitors[0]['h'] - height) // 2
                else:
                    x = (screen_width - width) // 2
                    y = (screen_height - height) // 2
        except Exception as e:
            print(f"Monitor detection failed: {e}")
            # Fallback: center on screen
            x = (screen_width - width) // 2
            y = (screen_height - height) // 2

        self.root.geometry(f'{width}x{height}+{x}+{y}')
        self.root.resizable(False, False)

        # Keep on top
        self.root.attributes('-topmost', True)

        # Style
        self.style = ttk.Style()
        self.style.theme_use('clam')
        self.style.configure('TFrame', background='#1e1e1e')
        self.style.configure('TLabel', background='#1e1e1e', foreground='#dcddde')
        self.style.configure('TButton', padding=10)
        self.style.configure('Search.TEntry', padding=10)

        self.build_ui()

        # Bind keys
        self.root.bind('<Escape>', lambda e: self.dismiss())
        self.root.bind('<Return>', lambda e: self.select_current())

        # Focus search
        self.search_var.set('')
        self.search_entry.focus_set()

    def load_tasks(self):
        """Load tasks from JSON file"""
        if not TASKS_FILE.exists():
            return []
        try:
            with open(TASKS_FILE) as f:
                return json.load(f)
        except:
            return []

    def load_quick_tasks(self):
        """Load quick-start task templates"""
        if not QUICK_TASKS_FILE.exists():
            return {'generic_tasks': [], 'customer_templates': []}
        try:
            with open(QUICK_TASKS_FILE) as f:
                return json.load(f)
        except:
            return {'generic_tasks': [], 'customer_templates': []}

    def build_ui(self):
        """Build the UI - Modern dark theme"""
        # Colors
        bg_dark = '#0d1117'
        bg_card = '#161b22'
        bg_hover = '#21262d'
        text_primary = '#e6edf3'
        text_secondary = '#8b949e'
        text_muted = '#484f58'
        accent_blue = '#58a6ff'
        accent_red = '#f85149'
        border_color = '#30363d'

        self.root.configure(bg=bg_dark)

        main_frame = tk.Frame(self.root, bg=bg_dark, padx=24, pady=20)
        main_frame.pack(fill=tk.BOTH, expand=True)

        # Header
        header_frame = tk.Frame(main_frame, bg=bg_dark)
        header_frame.pack(fill=tk.X, pady=(0, 20))

        emoji_label = tk.Label(header_frame, text="🍅", font=('Noto Color Emoji', 40),
                               bg=bg_dark, fg='white')
        emoji_label.pack()

        title_label = tk.Label(header_frame, text="Time to Focus!",
                               font=('Inter', 20, 'bold'), bg=bg_dark, fg=text_primary)
        title_label.pack(pady=(8, 4))

        subtitle_label = tk.Label(header_frame, text="Select a task or create a new one",
                                  font=('Inter', 11), bg=bg_dark, fg=text_secondary)
        subtitle_label.pack()

        # Tab buttons row
        tab_row = tk.Frame(main_frame, bg=bg_dark)
        tab_row.pack(fill=tk.X, pady=(0, 12))

        self.quick_tab_btn = tk.Button(tab_row, text="⚡ Quick Start", font=('Inter', 10),
                                       bg=bg_hover, fg=text_secondary, relief='flat', cursor='hand2',
                                       padx=12, pady=6, bd=0,
                                       command=lambda: self.switch_tab('quick'))
        self.quick_tab_btn.pack(side=tk.LEFT)

        self.tasks_tab_btn = tk.Button(tab_row, text="📋 My Tasks", font=('Inter', 10, 'bold'),
                                       bg=accent_blue, fg='white', relief='flat', cursor='hand2',
                                       padx=12, pady=6, bd=0,
                                       command=lambda: self.switch_tab('tasks'))
        self.tasks_tab_btn.pack(side=tk.LEFT, padx=(8, 0))

        # New Task button on right
        new_btn = tk.Button(tab_row, text="+ New", font=('Inter', 10, 'bold'),
                           bg='#238636', fg='white', relief='flat', cursor='hand2',
                           activebackground='#2ea043', activeforeground='white',
                           padx=12, pady=6, bd=0,
                           command=self.create_new_task)
        new_btn.pack(side=tk.RIGHT)

        # Store colors and references for tab switching
        self.tab_colors = {'bg_card': bg_card, 'bg_hover': bg_hover, 'text_primary': text_primary,
                           'text_secondary': text_secondary, 'accent_blue': accent_blue}

        # Search row (only shown in tasks tab)
        self.search_row = tk.Frame(main_frame, bg=bg_dark)

        search_container = tk.Frame(self.search_row, bg=border_color, padx=1, pady=1)
        search_container.pack(fill=tk.X)

        self.search_var = tk.StringVar()
        self.search_var.trace_add('write', self.on_search)

        self.search_entry = tk.Entry(search_container, textvariable=self.search_var,
                                     font=('Inter', 12), bg=bg_card, fg=text_primary,
                                     insertbackground=text_primary, relief='flat',
                                     highlightthickness=0)
        self.search_entry.pack(fill=tk.X, ipady=10, ipadx=12)

        # Bottom row - pack FIRST so it's never pushed off
        bottom_frame = tk.Frame(main_frame, bg=bg_dark)
        bottom_frame.pack(side=tk.BOTTOM, fill=tk.X, pady=(16, 0))

        # Hint on left
        hint_label = tk.Label(bottom_frame, text="↵ Select  •  Esc Dismiss",
                             font=('Inter', 10), bg=bg_dark, fg=text_muted)
        hint_label.pack(side=tk.LEFT)

        # Later button on right - larger and prominent
        dismiss_btn = tk.Button(bottom_frame, text="Later", font=('Inter', 12, 'bold'),
                               bg='#30363d', fg=text_primary, relief='flat', cursor='hand2',
                               activebackground='#484f58', activeforeground='white',
                               padx=28, pady=12, bd=0,
                               command=self.dismiss)
        dismiss_btn.pack(side=tk.RIGHT)

        # Content container - holds both quick tasks and task list panels
        self.content_frame = tk.Frame(main_frame, bg=bg_dark)
        self.content_frame.pack(fill=tk.BOTH, expand=True)

        # Store colors for task items
        self.colors = {
            'bg_card': bg_card, 'bg_hover': bg_hover, 'text_primary': text_primary,
            'text_secondary': text_secondary, 'border_color': border_color,
            'bg_dark': bg_dark, 'accent_blue': accent_blue
        }

        # === QUICK TASKS PANEL (scrollable) ===
        self.quick_panel = tk.Frame(self.content_frame, bg=bg_dark)

        # Scrollable container for quick tasks
        quick_container = tk.Frame(self.quick_panel, bg=border_color, padx=1, pady=1)
        quick_container.pack(fill=tk.BOTH, expand=True)

        quick_inner = tk.Frame(quick_container, bg=bg_card)
        quick_inner.pack(fill=tk.BOTH, expand=True)

        self.quick_canvas = tk.Canvas(quick_inner, bg=bg_card, highlightthickness=0, bd=0)
        quick_scrollbar = ttk.Scrollbar(quick_inner, orient=tk.VERTICAL, command=self.quick_canvas.yview)
        self.quick_frame = tk.Frame(self.quick_canvas, bg=bg_card)

        self.quick_canvas.configure(yscrollcommand=quick_scrollbar.set)
        quick_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.quick_canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=8, pady=8)

        self.quick_canvas_window = self.quick_canvas.create_window((0, 0), window=self.quick_frame, anchor='nw')
        self.quick_frame.bind('<Configure>', lambda e: self.quick_canvas.configure(scrollregion=self.quick_canvas.bbox('all')))
        self.quick_canvas.bind('<Configure>', lambda e: self.quick_canvas.itemconfig(self.quick_canvas_window, width=e.width))

        # Scroll handler for quick canvas - works on KDE/X11/Wayland
        def scroll_quick(event):
            # Button-4 = scroll wheel up = show content above = negative scroll
            # Button-5 = scroll wheel down = show content below = positive scroll
            if event.num == 4:
                self.quick_canvas.yview_scroll(-3, 'units')
            elif event.num == 5:
                self.quick_canvas.yview_scroll(3, 'units')
            elif hasattr(event, 'delta'):
                # MouseWheel event (Windows/Mac)
                self.quick_canvas.yview_scroll(-1 if event.delta > 0 else 1, 'units')
            return 'break'

        # Recursive bind to widget and all children
        def bind_scroll_to_widget(widget):
            widget.bind('<Button-4>', scroll_quick)
            widget.bind('<Button-5>', scroll_quick)
            widget.bind('<MouseWheel>', scroll_quick)  # Windows/Mac/some Linux
            for child in widget.winfo_children():
                bind_scroll_to_widget(child)

        # Bind to canvas, frame, and panel
        bind_scroll_to_widget(self.quick_panel)

        # Store for new widgets created later
        self._bind_scroll_quick = lambda w: bind_scroll_to_widget(w)

        # Customer templates section (at top for quick access)
        cust_label = tk.Label(self.quick_frame, text="Customer Quick Tasks", font=('Inter', 10, 'bold'),
                             bg=bg_card, fg=text_secondary)
        cust_label.pack(anchor='w', pady=(0, 8))

        # Customer selector row
        cust_row = tk.Frame(self.quick_frame, bg=bg_card)
        cust_row.pack(fill=tk.X, pady=(0, 8))

        customers = self.asana.get_customers() or list(CUSTOMER_COLORS.keys())
        self.customer_buttons = {}
        for cust in customers:
            color = CUSTOMER_COLORS.get(cust, '#666')
            btn = tk.Button(cust_row, text=cust, font=('Inter', 9, 'bold'),
                           bg=color, fg='white', relief='flat', cursor='hand2',
                           padx=8, pady=4, bd=0,
                           command=lambda c=cust: self.select_customer(c))
            btn.pack(side=tk.LEFT, padx=(0, 6))
            self.customer_buttons[cust] = btn

        # Customer template buttons (shown after customer selected)
        self.cust_templates_frame = tk.Frame(self.quick_frame, bg=bg_card)
        self.cust_templates_frame.pack(fill=tk.X, pady=(0, 8))

        self.cust_hint = tk.Label(self.quick_frame, text="↑ Select a customer first",
                                 font=('Inter', 9), bg=bg_card, fg=text_muted)
        self.cust_hint.pack(anchor='w')

        # Generic tasks section (below customer tasks)
        generic_label = tk.Label(self.quick_frame, text="Generic Tasks", font=('Inter', 10, 'bold'),
                                bg=bg_card, fg=text_secondary)
        generic_label.pack(anchor='w', pady=(16, 8))

        generic_frame = tk.Frame(self.quick_frame, bg=bg_card)
        generic_frame.pack(fill=tk.X, pady=(0, 8))

        for task in self.quick_tasks_config.get('generic_tasks', []):
            self.create_quick_task_button(generic_frame, task, None)

        # === TASK LIST PANEL ===
        self.tasks_panel = tk.Frame(self.content_frame, bg=bg_dark)

        list_container = tk.Frame(self.tasks_panel, bg=border_color, padx=1, pady=1)
        list_container.pack(fill=tk.BOTH, expand=True)

        list_inner = tk.Frame(list_container, bg=bg_card, height=280)
        list_inner.pack(fill=tk.BOTH, expand=True)
        list_inner.pack_propagate(False)

        self.canvas = tk.Canvas(list_inner, bg=bg_card, highlightthickness=0, bd=0)
        scrollbar = ttk.Scrollbar(list_inner, orient=tk.VERTICAL, command=self.canvas.yview)
        self.task_frame = tk.Frame(self.canvas, bg=bg_card)

        self.canvas.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=8, pady=8)

        self.canvas_window = self.canvas.create_window((0, 0), window=self.task_frame, anchor='nw')
        self.task_frame.bind('<Configure>', self.on_frame_configure)
        self.canvas.bind('<Configure>', self.on_canvas_configure)

        # Scroll handler for tasks canvas (same pattern as quick canvas)
        def scroll_tasks(event):
            if event.num == 4:
                self.canvas.yview_scroll(-3, 'units')
            elif event.num == 5:
                self.canvas.yview_scroll(3, 'units')
            elif hasattr(event, 'delta'):
                self.canvas.yview_scroll(-1 if event.delta > 0 else 1, 'units')
            return 'break'

        def bind_tasks_scroll(widget):
            widget.bind('<Button-4>', scroll_tasks)
            widget.bind('<Button-5>', scroll_tasks)
            widget.bind('<MouseWheel>', scroll_tasks)
            for child in widget.winfo_children():
                bind_tasks_scroll(child)

        # Bind to entire tasks_panel container (like quick_panel)
        # Also add Enter binding to give canvas focus
        def on_enter_tasks(e):
            self.canvas.focus_set()
        self.tasks_panel.bind('<Enter>', on_enter_tasks)
        self.canvas.bind('<Enter>', on_enter_tasks)

        # Bind directly to canvas as well
        self.canvas.bind('<Button-4>', scroll_tasks)
        self.canvas.bind('<Button-5>', scroll_tasks)
        self.canvas.bind('<MouseWheel>', scroll_tasks)

        self._bind_tasks_scroll = lambda: bind_tasks_scroll(self.tasks_panel)

        # Initialize: show tasks panel (Obsidian tasks) by default
        self.search_row.pack(fill=tk.X, pady=(0, 8))
        self.tasks_panel.pack(fill=tk.BOTH, expand=True)
        self.populate_tasks()
        self.search_entry.focus_set()

        # Bind scroll to all widgets after UI is built
        self.root.after(100, lambda: self._bind_scroll_quick(self.quick_panel))
        self.root.after(100, self._bind_tasks_scroll)

    def on_frame_configure(self, event):
        self.canvas.configure(scrollregion=self.canvas.bbox('all'))

    def on_canvas_configure(self, event):
        self.canvas.itemconfig(self.canvas_window, width=event.width)

    def switch_tab(self, tab):
        """Switch between quick tasks and full task list"""
        bg_hover = self.colors.get('bg_hover', '#21262d')
        text_secondary = self.colors.get('text_secondary', '#8b949e')
        accent_blue = self.colors.get('accent_blue', '#58a6ff')

        if tab == 'quick':
            self.show_quick_tasks = True
            self._active_canvas = self.quick_canvas
            self.quick_tab_btn.configure(bg=accent_blue, fg='white', font=('Inter', 10, 'bold'))
            self.tasks_tab_btn.configure(bg=bg_hover, fg=text_secondary, font=('Inter', 10))
            self.tasks_panel.pack_forget()
            self.search_row.pack_forget()
            self.quick_panel.pack(fill=tk.BOTH, expand=True)
        else:
            self.show_quick_tasks = False
            self._active_canvas = self.canvas
            self.tasks_tab_btn.configure(bg=accent_blue, fg='white', font=('Inter', 10, 'bold'))
            self.quick_tab_btn.configure(bg=bg_hover, fg=text_secondary, font=('Inter', 10))
            self.quick_panel.pack_forget()
            self.search_row.pack(fill=tk.X, pady=(0, 8))
            self.tasks_panel.pack(fill=tk.BOTH, expand=True)
            self.search_entry.focus_set()
            self.root.after(50, self._bind_tasks_scroll)

    def create_quick_task_button(self, parent, task_config, customer):
        """Create a clickable quick task button"""
        bg_hover = self.colors.get('bg_hover', '#21262d')
        text_primary = self.colors.get('text_primary', '#e6edf3')
        border_color = self.colors.get('border_color', '#30363d')

        icon = task_config.get('icon', '📌')
        text = task_config.get('text', 'Task')

        btn = tk.Button(parent, text=f"{icon} {text}", font=('Inter', 10),
                       bg=border_color, fg=text_primary, relief='flat', cursor='hand2',
                       activebackground=bg_hover, activeforeground='white',
                       padx=12, pady=8, bd=0, anchor='w',
                       command=lambda: self.start_quick_task(text, customer))
        btn.pack(fill=tk.X, pady=2)

    def select_customer(self, customer):
        """Select a customer and show available templates"""
        self.selected_customer = customer

        # Update button styles
        for cust, btn in self.customer_buttons.items():
            color = CUSTOMER_COLORS.get(cust, '#666')
            if cust == customer:
                btn.configure(relief='solid', bd=2)
            else:
                btn.configure(relief='flat', bd=0)

        # Clear and populate templates
        for widget in self.cust_templates_frame.winfo_children():
            widget.destroy()

        self.cust_hint.pack_forget()

        for template in self.quick_tasks_config.get('customer_templates', []):
            self.create_quick_task_button(self.cust_templates_frame, template, customer)

    def start_quick_task(self, task_text, customer=None):
        """Start a quick task"""
        if customer:
            full_text = f"{customer} {task_text}"
            tag = f"#{customer.lower()}"
        else:
            full_text = task_text
            customer = 'Internal'
            tag = '#internal'

        task = {
            'text': full_text,
            'customer': customer,
            'tag': tag,
            'asana_url': '',
            'status': 'quick_task'
        }
        self.select_task(task)

    def populate_tasks(self):
        """Populate task list"""
        # Clear existing
        for widget in self.task_frame.winfo_children():
            widget.destroy()

        for i, task in enumerate(self.filtered_tasks):
            self.create_task_item(task, i)

        # Rebind scroll to new widgets
        if hasattr(self, '_bind_tasks_scroll'):
            self.root.after(50, self._bind_tasks_scroll)

    def create_task_item(self, task, index):
        """Create a single task item with colored badge"""
        customer = task.get('customer', 'Internal')
        text = task.get('text', 'Unknown task')
        color = CUSTOMER_COLORS.get(customer, '#95a5a6')

        bg_card = self.colors.get('bg_card', '#161b22')
        bg_hover = self.colors.get('bg_hover', '#21262d')
        text_primary = self.colors.get('text_primary', '#e6edf3')

        # Item frame
        item_frame = tk.Frame(self.task_frame, bg=bg_card, cursor='hand2')
        item_frame.pack(fill=tk.X, pady=3, padx=4)

        # Hover effect
        def on_enter(e):
            item_frame.configure(bg=bg_hover)
            text_container.configure(bg=bg_hover)
            label.configure(bg=bg_hover)

        def on_leave(e):
            item_frame.configure(bg=bg_card)
            text_container.configure(bg=bg_card)
            label.configure(bg=bg_card)

        def on_click(e, t=task):
            self.select_task(t)

        item_frame.bind('<Enter>', on_enter)
        item_frame.bind('<Leave>', on_leave)
        item_frame.bind('<Button-1>', on_click)

        # Customer badge with colored background
        badge = tk.Label(item_frame, text=f" {customer} ", font=('Inter', 9, 'bold'),
                        bg=color, fg='white', padx=6, pady=2)
        badge.pack(side=tk.LEFT, padx=(8, 12), pady=10)
        badge.bind('<Button-1>', on_click)

        # Text container for vertical centering
        text_container = tk.Frame(item_frame, bg=bg_card)
        text_container.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        text_container.bind('<Button-1>', on_click)

        # Task text
        label = tk.Label(text_container, text=text, font=('Inter', 11),
                        bg=bg_card, fg=text_primary, anchor='w', wraplength=300)
        label.pack(side=tk.LEFT, fill=tk.X, expand=True, pady=10)
        label.bind('<Button-1>', on_click)

    def on_search(self, *args):
        """Filter tasks based on search"""
        query = self.search_var.get().lower()
        if not query:
            self.filtered_tasks = self.tasks.copy()
        else:
            self.filtered_tasks = [
                t for t in self.tasks
                if query in t.get('text', '').lower() or
                   query in t.get('customer', '').lower() or
                   query in t.get('tag', '').lower()
            ]
        self.populate_tasks()

    def select_task(self, task):
        """Select a task and close"""
        self.selected_task = task
        self.save_result()
        self.root.destroy()

    def select_current(self):
        """Select first visible task on Enter"""
        if self.filtered_tasks:
            self.select_task(self.filtered_tasks[0])

    def create_new_task(self):
        """Open dialog to create new task (optionally synced to Asana)"""
        search_text = self.search_var.get().strip()

        dialog = tk.Toplevel(self.root)
        dialog.title("New Task")
        dialog.configure(bg='#1e1e1e')
        dialog.geometry('420x280')
        dialog.transient(self.root)
        dialog.grab_set()

        # Center on parent
        dialog.geometry(f'+{self.root.winfo_x() + 40}+{self.root.winfo_y() + 80}')

        frame = tk.Frame(dialog, bg='#1e1e1e', padx=20, pady=20)
        frame.pack(fill=tk.BOTH, expand=True)

        # Task name
        tk.Label(frame, text="Task name:", bg='#1e1e1e', fg='#dcddde',
                font=('Segoe UI', 11)).pack(anchor='w')

        task_var = tk.StringVar(value=search_text)
        task_entry = tk.Entry(frame, textvariable=task_var, font=('Segoe UI', 12),
                             bg='#2d2d2d', fg='#dcddde', insertbackground='#dcddde',
                             relief='flat', highlightthickness=1, highlightbackground='#404040')
        task_entry.pack(fill=tk.X, ipady=6, pady=(5, 15))
        task_entry.focus_set()

        # Customer dropdown
        tk.Label(frame, text="Customer:", bg='#1e1e1e', fg='#dcddde',
                font=('Segoe UI', 11)).pack(anchor='w')

        # Use Asana-configured customers if available, otherwise defaults
        asana_customers = self.asana.get_customers()
        customers = asana_customers if asana_customers else list(CUSTOMER_COLORS.keys())
        if 'Internal' not in customers:
            customers.append('Internal')

        customer_var = tk.StringVar(value=customers[0] if customers else 'Internal')
        customer_combo = ttk.Combobox(frame, textvariable=customer_var, values=customers,
                                      state='readonly', font=('Segoe UI', 11))
        customer_combo.pack(fill=tk.X, pady=(5, 15))

        # Sync to Asana checkbox
        sync_var = tk.BooleanVar(value=True)
        sync_check = tk.Checkbutton(frame, text="Create in Asana", variable=sync_var,
                                   bg='#1e1e1e', fg='#dcddde', selectcolor='#2d2d2d',
                                   activebackground='#1e1e1e', activeforeground='#dcddde',
                                   font=('Segoe UI', 11))
        sync_check.pack(anchor='w', pady=(0, 15))

        # Status label
        status_var = tk.StringVar(value='')
        status_label = tk.Label(frame, textvariable=status_var, bg='#1e1e1e', fg='#f39c12',
                               font=('Segoe UI', 10))
        status_label.pack(anchor='w')

        # Buttons
        btn_frame = tk.Frame(frame, bg='#1e1e1e')
        btn_frame.pack(fill=tk.X, pady=(10, 0))

        def save_new():
            name = task_var.get().strip()
            customer = customer_var.get()
            if not name:
                return

            asana_url = ''

            if sync_var.get() and customer != 'Internal':
                status_var.set('Creating in Asana...')
                dialog.update()

                result = self.asana.create_task(name, customer)
                if result:
                    asana_url = result.get('permalink', '')
                    status_var.set('✓ Created in Asana')
                else:
                    status_var.set('⚠ Asana sync failed (continuing locally)')
                dialog.update()

            new_task = {
                'text': name,
                'customer': customer,
                'tag': f'#{customer.lower()}',
                'asana_url': asana_url,
                'status': 'in_progress'
            }
            self.select_task(new_task)
            dialog.destroy()

        tk.Button(btn_frame, text="Start Timer", font=('Segoe UI', 11, 'bold'),
                 bg='#e74c3c', fg='white', relief='flat', cursor='hand2',
                 activebackground='#c0392b', command=save_new).pack(side=tk.RIGHT)

        tk.Button(btn_frame, text="Cancel", font=('Segoe UI', 11),
                 bg='#2d2d2d', fg='#999', relief='flat', cursor='hand2',
                 command=dialog.destroy).pack(side=tk.RIGHT, padx=(0, 10))

        dialog.bind('<Return>', lambda e: save_new())
        dialog.bind('<Escape>', lambda e: dialog.destroy())

    def dismiss(self):
        """Close without selecting"""
        self.selected_task = None
        self.save_result()
        self.root.destroy()

    def save_result(self):
        """Save result to file for Obsidian to read"""
        result = {
            'selected': self.selected_task is not None,
            'task': self.selected_task
        }
        RESULT_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(RESULT_FILE, 'w') as f:
            json.dump(result, f)

    def run(self):
        """Run the popup"""
        self.root.mainloop()


if __name__ == '__main__':
    app = IdleReminderPopup()
    app.run()
