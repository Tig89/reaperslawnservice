# Battle Plan

A simple, mobile-friendly PWA for daily life organization. Capture tasks, prioritize your Top 3, and focus on what matters.

## Features

### Inbox
- Quick capture with big input field
- Keyboard shortcuts for fast triage:
  - `T` - Mark as Today
  - `N` - Mark as Next
  - `W` - Mark as Waiting
  - `S` - Mark as Someday
  - `D` - Mark as Done
  - `E` - Edit item
  - `Delete` - Delete item
- Tag items: Home, Army, Business
- Add time estimates and due dates

### Today
- View all items marked for Today
- **Lock Top 3 Priorities** (hard cap of 3)
- See total estimated time for Today and Top 3
- **Focus Mode**: Start a timer (25/50/custom minutes) and hide distractions

### Routines
- Create reusable checklist templates
- Examples: Morning Reset, Evening Shutdown, Grocery Run
- One-click "Run Routine" copies items to Today

### Data
- **100% Local-first** - Your data stays on your device
- Uses IndexedDB for storage
- Export/Import JSON backups
- Works completely offline

---

## Quick Start

### Option 1: Local Development Server

```bash
# Using Python
python3 -m http.server 8080

# Using Node.js (npx)
npx serve .

# Using PHP
php -S localhost:8080
```

Then open `http://localhost:8080` in your browser.

### Option 2: Deploy to Web Server

Upload all files to any static web host:
- GitHub Pages
- Netlify
- Vercel
- Any web server (Apache, Nginx)

**Note:** PWAs require HTTPS in production (except localhost).

---

## Install as PWA on Android

1. Open the app in Chrome on your Android device
2. Tap the **three-dot menu** (⋮) in the top right
3. Tap **"Add to Home Screen"** or **"Install App"**
4. Confirm the installation
5. The app will appear on your home screen with its icon

### Install on iOS (Safari)

1. Open the app in Safari
2. Tap the **Share button** (square with arrow)
3. Scroll down and tap **"Add to Home Screen"**
4. Tap **"Add"**

### Install on Desktop (Chrome/Edge)

1. Open the app in Chrome or Edge
2. Click the **install icon** in the address bar (or menu > Install)
3. Confirm installation

---

## Project Structure

```
battle-plan/
├── index.html          # Main HTML shell
├── manifest.json       # PWA manifest
├── sw.js              # Service worker (offline support)
├── css/
│   └── styles.css     # All styles
├── js/
│   ├── db.js          # IndexedDB storage layer
│   └── app.js         # Main application logic
├── icons/
│   └── icon.svg       # App icon (SVG)
└── README.md
```

---

## Generating PNG Icons

For full PWA support, generate PNG icons from the SVG:

### Using ImageMagick (CLI)

```bash
# Install ImageMagick first
convert -background none icons/icon.svg -resize 192x192 icons/icon-192.png
convert -background none icons/icon.svg -resize 512x512 icons/icon-512.png
```

### Using Online Tools

1. Go to [realfavicongenerator.net](https://realfavicongenerator.net/)
2. Upload `icons/icon.svg`
3. Download the generated icons
4. Replace files in `icons/` folder

---

## Usage Tips

### Daily Workflow

1. **Morning**: Capture everything in Inbox
2. **Triage**: Use keyboard shortcuts to categorize (T/N/W/S)
3. **Prioritize**: Go to Today, lock your Top 3
4. **Execute**: Use Focus mode to work without distractions
5. **Evening**: Review, mark done, plan tomorrow

### Keyboard Flow

When an item is selected in Inbox:
- Press `T` → marks as Today
- Press `N` → marks as Next (do soon)
- Press `W` → marks as Waiting (blocked)
- Press `S` → marks as Someday (maybe later)
- Press `D` → marks as Done

### Routines

Create routines for repeated tasks:
- **Morning Reset**: Review calendar, check email, plan day
- **Evening Shutdown**: Clear inbox, review tomorrow, gratitude
- **Weekly Review**: Review projects, update lists, plan week

---

## Backup Your Data

1. Go to **Settings** (gear icon)
2. Click **Export JSON**
3. Save the file somewhere safe

To restore:
1. Click **Import JSON**
2. Select your backup file

---

## Technical Notes

- **Storage**: IndexedDB (no size limits like localStorage)
- **Offline**: Service Worker caches all assets
- **No tracking**: Zero analytics or external requests
- **No frameworks**: Pure vanilla JavaScript (~500 lines)

---

## License

MIT License - Use freely for personal or commercial projects.
