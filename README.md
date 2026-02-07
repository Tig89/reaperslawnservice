# Battle Plan

A mobile-friendly PWA for daily task management with ACE+LMT prioritization scoring, AI-powered voice input, capacity planning, and focus tools. Capture tasks, prioritize your Top 3, and execute.

## Features

### Task Management
- **Inbox** — Quick capture with smart parsing (AI or regex-based)
- **Today / Tomorrow / Next / Waiting / Someday / Done** — Full task lifecycle
- **Subtasks** — Break items into smaller pieces
- **Recurring tasks** — Daily, weekly, or monthly recurrence
- **Due dates** — Track deadlines with overdue warnings
- **Tags** — Categorize as Home, Army, Business, or Other
- **Swipe gestures** — Swipe to triage on mobile
- **Undo** — 5-second undo window after status changes

### ACE+LMT Scoring
Each task can be rated on six dimensions:
- **A**ction clarity, **C**riticality, **E**ffort estimate
- **L**everage, **M**omentum, **T**ime sensitivity

Scores drive auto-scheduling, Top 3 suggestions, and capacity planning.

### Top 3 Priorities
- Lock up to 3 tasks as your daily focus
- Manual or auto-suggested based on scores
- Lock individual items to prevent auto-replacement
- Monster task warnings (90+ minute estimates)

### Capacity Planning
- Set weekday/weekend capacity in minutes
- Configurable slack percentage
- **Auto-schedule** — Fits highest-priority tasks into available time, overflows the rest
- **Time pressure detection** — Alerts when remaining tasks exceed remaining hours
- **Reracking** — Automatically rebalances after completions or time pressure

### Focus Mode
- Pomodoro-style timer (25/50/custom minutes)
- Pause and resume
- Distraction-free interface during focus sessions

### Voice Input
- Hands-free task capture via Web Speech API
- Natural language commands: "add", "finish", "move to tomorrow"
- Works with or without AI — falls back to regex parsing offline

### AI Integration (Optional)
- **Groq API** (llama-3.1-8b-instant) for smart task parsing
- Extracts dates, recurrence, tags, and time estimates from natural language
- Voice command intent detection (add, complete, move, navigate, query)
- AI-powered stats responses ("How's my day looking?")
- Bring your own API key — disabled by default

### Routines
- Create reusable checklist templates
- One-click "Run Routine" copies items to Today
- Examples: Morning Reset, Evening Shutdown, Weekly Review

### Analytics
- Daily stats: rated/unrated, capacity usage, overdue count
- Top 5 priorities by score
- Monster task tracking

### Themes
- **Dark** (default) — Dark navy blue
- **Light** — Clean white
- **Matrix** — Green-on-black terminal aesthetic
- **Windows 98** — Retro desktop style

### Data & Privacy
- **100% local-first** — All data stored in IndexedDB on your device
- **Offline capable** — Service worker caches all assets (network-first strategy)
- **Export/Import** — JSON backup and restore
- **Auto-backup** — Automatic backup scheduling
- **No tracking** — Zero analytics, no telemetry
- **Security** — CSP headers, input sanitization, field whitelisting on import
- Only external connection: Groq API (opt-in, requires your own key)

---

## Quick Start

### Local Development

```bash
# Python
python3 -m http.server 8080

# Node.js
npx serve .

# PHP
php -S localhost:8080
```

Open `http://localhost:8080` in your browser.

### Deploy

Upload all files to any static host: GitHub Pages, Netlify, Vercel, or any web server.

**Note:** PWAs require HTTPS in production (localhost is exempt).

---

## Install as PWA

### Android (Chrome)
1. Open the app in Chrome
2. Tap the three-dot menu > **"Install App"**
3. Confirm — the app appears on your home screen

### iOS (Safari)
1. Open in Safari
2. Tap **Share** > **"Add to Home Screen"** > **Add**

### Desktop (Chrome / Edge)
1. Open in Chrome or Edge
2. Click the install icon in the address bar
3. Confirm installation

---

## Keyboard Shortcuts

When a task is selected:
| Key | Action |
|-----|--------|
| `T` | Move to Today |
| `N` | Move to Next |
| `W` | Move to Waiting |
| `S` | Move to Someday |
| `D` | Mark as Done |
| `E` | Edit item |
| `Delete` | Delete item |

---

## Project Structure

```
reaperslawnservice/
├── index.html          # Main HTML shell (single-page app)
├── manifest.json       # PWA manifest
├── sw.js               # Service worker (network-first caching)
├── css/
│   └── styles.css      # All styles + 4 themes
├── js/
│   ├── app.js          # UI, events, rendering (~4,400 lines)
│   ├── db.js           # IndexedDB layer, scoring, scheduling (~1,500 lines)
│   ├── groq.js         # Groq AI integration (~240 lines)
│   └── sw-register.js  # Service worker registration
├── icons/
│   └── icon.svg        # App icon
├── LICENSE
└── README.md
```

---

## Daily Workflow

1. **Capture** — Dump tasks into Inbox (type or voice)
2. **Triage** — Move to Today, Next, Waiting, or Someday
3. **Rate** — Score tasks with ACE+LMT for smart prioritization
4. **Lock Top 3** — Pick (or auto-suggest) your three priorities
5. **Focus** — Use the timer, work through #1, #2, #3
6. **Review** — Mark done, check analytics, plan tomorrow

---

## Backup & Restore

1. Go to **Settings**
2. Tap **Export JSON** to download a backup
3. To restore: tap **Import JSON** and select the file

Backups include all tasks, routines, settings, and calibration history.

---

## Technical Details

- **Storage**: IndexedDB v4 (items, routines, settings, calibration_history)
- **Offline**: Service worker with network-first strategy, full offline fallback
- **Security**: Content Security Policy, X-Frame-Options DENY, input sanitization, field whitelisting
- **AI**: Groq API (llama-3.1-8b-instant) — optional, bring your own key
- **Voice**: Web Speech API (browser-native, no external service)
- **Frameworks**: None — pure vanilla JavaScript, zero dependencies

---

## License

MIT License — see [LICENSE](LICENSE) for details.
