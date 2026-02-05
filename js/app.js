/**
 * Battle Plan - Main Application
 * Army-style task prioritization with ACE+LMT scoring
 */

// ==================== DEBUG ====================
// Set to true to enable detailed error logging (disable in production)
const DEBUG = false;

function debugLog(level, message, data) {
  if (!DEBUG) return;
  const methods = { error: console.error, warn: console.warn, log: console.log };
  const method = methods[level] || console.log;
  if (data) {
    method(`[BattlePlan] ${message}`, data);
  } else {
    method(`[BattlePlan] ${message}`);
  }
}

// ==================== CONSTANTS ====================
const CONSTANTS = {
  MAX_TASK_LENGTH: 500,
  MAX_NOTES_LENGTH: 2000,
  MAX_SEARCH_LENGTH: 200,
  MAX_TAG_LENGTH: 50,
  MAX_IMPORT_ITEMS: 1000,
  TOP3_LIMIT: 3,
  UNDO_TIMEOUT_MS: 5000,
  SEARCH_DEBOUNCE_MS: 300,
  DEFAULT_SWIPE_THRESHOLD: 0.45,
  DEFAULT_TIMER_MINUTES: 25,
  MONSTER_THRESHOLD_MINUTES: 90,
  NOTIFICATION_CHECK_INTERVAL_MS: 60 * 60 * 1000, // 1 hour
  STORAGE_WARNING_PERCENT: 80,
  VALID_STATUSES: ['inbox', 'today', 'tomorrow', 'next', 'waiting', 'someday', 'done'],
  VALID_TAGS: ['Home', 'Army', 'Business', 'Other'],
  VALID_CONFIDENCES: ['high', 'medium', 'low'],
  VALID_RECURRENCES: ['', 'daily', 'weekly', 'monthly']
};

class BattlePlanApp {
  constructor() {
    this.currentPage = 'inbox';
    this.selectedItemId = null;
    this.editingItemId = null;
    this.editingRoutineId = null;
    this.focusTimer = null;
    this.focusTimeRemaining = 0;
    this.focusPaused = false;
    this.timerDefault = CONSTANTS.DEFAULT_TIMER_MINUTES;
    this.searchQuery = '';
    this.searchTimeout = null;

    // Edit modal state
    this.editState = {
      A: null, C: null, E: null,
      L: null, M: null, T: null,
      tag: null,
      estimate_bucket: null,
      confidence: null
    };

    // Pending completion for actual time tracking
    this.pendingCompletionId = null;

    // Pending import data for confirmation
    this.pendingImportData = null;

    // Pending waiting item
    this.pendingWaitingId = null;

    // Swipe gesture state
    this.swipeState = null;
    this.swipeEnabled = true;
    this.swipeThreshold = CONSTANTS.DEFAULT_SWIPE_THRESHOLD;
    this.trayCloseHandler = null; // Track close handler to prevent memory leaks

    // Voice input state
    this.speechRecognition = null;
    this.isListening = false;
    this.voiceSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    this.voiceStartLock = false;

    // Undo state
    this.lastAction = null; // { type, itemId, previousState, description }
    this.undoTimeout = null;
    this.undoCountdownInterval = null;

    // Notification state
    this.notificationsEnabled = localStorage.getItem('battlePlanNotifications') === 'true';
    this.lastNotificationCheck = null;

    // Score cache for performance
    this.scoreCache = new Map();
    this.scoreCacheTime = 0;

    // HUD cache for performance (avoid recalculating on every navigation)
    this.hudCache = null;
    this.hudCacheTime = 0;
    this.hudCacheTTL = 3000; // 3 seconds

    // Archive state
    this.showArchived = false;

    this.init();
  }

  async init() {
    await db.ready;

    // Run rollover on app load
    await db.runRollover();

    // Load settings
    this.timerDefault = await db.getSetting('timerDefault', 25);
    this.swipeEnabled = await db.getSetting('enable_swipe_gestures', true);
    this.swipeThreshold = await db.getSetting('swipe_threshold', 0.45);

    // Initialize voice input if supported
    this.initVoiceInput();

    this.bindEvents();

    // Load theme preference
    this.loadTheme();

    // Load Groq AI settings
    this.loadGroqSettings();

    // Handle initial page from URL hash (for back button support)
    const hash = window.location.hash.slice(1);
    const validPages = ['inbox', 'today', 'tomorrow', 'next', 'waiting', 'someday', 'done', 'routines', 'analytics', 'settings'];
    if (hash && validPages.includes(hash)) {
      this.navigateTo(hash, false);
    }
    // Set initial history state
    history.replaceState({ page: this.currentPage }, '', `#${this.currentPage}`);

    this.render();
    this.updateHUD();

    // Check for due date notifications
    setTimeout(() => this.checkDueNotifications(), 2000);

    // Check periodically (every hour)
    setInterval(() => this.checkDueNotifications(), 60 * 60 * 1000);

    // Offline/online detection
    this.updateOfflineIndicator();
    window.addEventListener('online', () => this.updateOfflineIndicator());
    window.addEventListener('offline', () => this.updateOfflineIndicator());

    // Check storage quota
    this.checkStorageQuota();
  }

  async checkStorageQuota() {
    if (!navigator.storage || !navigator.storage.estimate) {
      document.getElementById('storage-usage').textContent = 'N/A';
      return;
    }

    try {
      const estimate = await navigator.storage.estimate();
      const usage = estimate.usage || 0;
      const quota = estimate.quota || 0;

      if (quota > 0) {
        const percentUsed = (usage / quota) * 100;
        const usageMB = (usage / (1024 * 1024)).toFixed(1);
        const quotaMB = (quota / (1024 * 1024)).toFixed(0);

        const storageEl = document.getElementById('storage-usage');
        storageEl.textContent = `${usageMB}MB / ${quotaMB}MB (${Math.round(percentUsed)}%)`;

        if (percentUsed >= 80) {
          storageEl.classList.add('storage-warning');
          this.showToast(`Storage ${Math.round(percentUsed)}% full. Consider exporting data.`, 'warning');
        }
      }
    } catch (e) {
      debugLog('warn', 'Could not check storage quota', e);
      document.getElementById('storage-usage').textContent = 'N/A';
    }
  }

  updateOfflineIndicator() {
    const indicator = document.getElementById('offline-indicator');
    if (navigator.onLine) {
      indicator.classList.add('hidden');
    } else {
      indicator.classList.remove('hidden');
    }
  }

  // ==================== THEME ====================

  setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('battlePlanTheme', theme);

    // Update button states
    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    document.getElementById(`theme-${theme}`).classList.add('active');
  }

  loadTheme() {
    const savedTheme = localStorage.getItem('battlePlanTheme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);

    // Update button states
    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.classList.toggle('active', btn.id === `theme-${savedTheme}`);
    });
  }

  // ==================== GROQ AI SETTINGS ====================

  loadGroqSettings() {
    const keyInput = document.getElementById('setting-groq-api-key');
    const statusSpan = document.getElementById('groq-key-status');

    if (groqAssistant.hasApiKey()) {
      // Show masked key
      keyInput.value = '••••••••••••••••';
      keyInput.placeholder = 'Key saved (click to change)';
      statusSpan.textContent = '✓ Configured';
      statusSpan.style.color = 'var(--success)';
    } else {
      keyInput.value = '';
      statusSpan.textContent = '';
    }
  }

  saveGroqApiKey() {
    const keyInput = document.getElementById('setting-groq-api-key');
    const statusSpan = document.getElementById('groq-key-status');
    const key = keyInput.value.trim();

    // Don't save if it's the masked placeholder
    if (key === '••••••••••••••••' || key === '') {
      statusSpan.textContent = 'Please enter an API key';
      statusSpan.style.color = 'var(--warning)';
      return;
    }

    if (!key.startsWith('gsk_')) {
      statusSpan.textContent = 'Invalid key format (should start with gsk_)';
      statusSpan.style.color = 'var(--danger)';
      return;
    }

    groqAssistant.setApiKey(key);
    keyInput.value = '••••••••••••••••';
    statusSpan.textContent = '✓ Saved!';
    statusSpan.style.color = 'var(--success)';
    this.showToast('Groq API key saved');
  }

  async testGroqApiKey() {
    const statusSpan = document.getElementById('groq-key-status');

    if (!groqAssistant.hasApiKey()) {
      statusSpan.textContent = 'No API key configured';
      statusSpan.style.color = 'var(--warning)';
      return;
    }

    statusSpan.textContent = 'Testing...';
    statusSpan.style.color = 'var(--text-secondary)';

    try {
      const result = await groqAssistant.parseIntent('hello', {});
      if (result.error && result.error.includes('API')) {
        statusSpan.textContent = '✗ Invalid key';
        statusSpan.style.color = 'var(--danger)';
      } else {
        statusSpan.textContent = '✓ Working!';
        statusSpan.style.color = 'var(--success)';
        this.showToast('Groq AI is ready!');
      }
    } catch (err) {
      statusSpan.textContent = '✗ Connection failed';
      statusSpan.style.color = 'var(--danger)';
    }
  }

  // ==================== EVENT BINDING ====================

  bindEvents() {
    // Navigation
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => this.navigateTo(btn.dataset.page));
    });

    // Handle browser back/forward buttons (Android back button support)
    window.addEventListener('popstate', (e) => this.handlePopState(e));

    // Search (debounced for performance)
    document.getElementById('search-input').addEventListener('input', (e) => {
      // Limit search query length to prevent DoS
      const value = e.target.value;
      this.searchQuery = value.substring(0, CONSTANTS.MAX_SEARCH_LENGTH);
      if (value.length > CONSTANTS.MAX_SEARCH_LENGTH) {
        e.target.value = this.searchQuery;
      }
      // Debounce: wait 300ms after typing stops before rendering
      if (this.searchTimeout) clearTimeout(this.searchTimeout);
      this.searchTimeout = setTimeout(() => this.render(), 300);
    });

    // Inbox
    document.getElementById('inbox-input').addEventListener('keydown', (e) => this.handleInboxKeydown(e));
    document.getElementById('inbox-add-btn').addEventListener('click', () => this.addInboxItem());

    // Today actions
    document.getElementById('start-focus-btn').addEventListener('click', () => this.startFocus());
    document.getElementById('suggest-top3-btn').addEventListener('click', () => this.suggestTop3());
    document.getElementById('rebuild-top3-btn').addEventListener('click', () => this.rebuildTop3());
    document.getElementById('auto-balance-btn').addEventListener('click', () => this.autoBalance());

    // Done page actions
    document.getElementById('archive-old-btn').addEventListener('click', () => this.archiveOldTasks());
    document.getElementById('show-archived').addEventListener('change', (e) => {
      this.showArchived = e.target.checked;
      this.renderByStatus('done');
    });

    // Routines
    document.getElementById('routine-name-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.addRoutine();
    });
    document.getElementById('add-routine-btn').addEventListener('click', () => this.addRoutine());

    // Settings
    document.getElementById('export-btn').addEventListener('click', () => this.exportData());
    document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-file').click());
    document.getElementById('import-file').addEventListener('change', (e) => this.importData(e));
    document.querySelectorAll('.timer-preset').forEach(btn => {
      btn.addEventListener('click', () => this.setTimerPreset(btn));
    });
    document.getElementById('custom-timer').addEventListener('change', (e) => this.setCustomTimer(e));

    // Capacity settings
    document.getElementById('setting-weekday-capacity').addEventListener('change', (e) => {
      db.setSetting('weekday_capacity_minutes', parseInt(e.target.value) || 180);
      this.updateHUD();
    });
    document.getElementById('setting-weekend-capacity').addEventListener('change', (e) => {
      db.setSetting('weekend_capacity_minutes', parseInt(e.target.value) || 360);
      this.updateHUD();
    });
    document.getElementById('setting-slack').addEventListener('change', (e) => {
      db.setSetting('always_plan_slack_percent', parseInt(e.target.value) || 30);
      this.updateHUD();
    });

    // Behavior settings
    document.getElementById('setting-top3-clear').addEventListener('change', (e) => {
      db.setSetting('top3_auto_clear_daily', e.target.checked);
    });
    document.getElementById('setting-swipe-gestures').addEventListener('change', (e) => {
      this.swipeEnabled = e.target.checked;
      db.setSetting('enable_swipe_gestures', e.target.checked);
    });
    document.getElementById('setting-swipe-threshold').addEventListener('change', (e) => {
      this.swipeThreshold = parseFloat(e.target.value);
      db.setSetting('swipe_threshold', this.swipeThreshold);
    });

    // Theme toggle
    document.getElementById('theme-dark').addEventListener('click', () => this.setTheme('dark'));
    document.getElementById('theme-light').addEventListener('click', () => this.setTheme('light'));
    document.getElementById('theme-matrix').addEventListener('click', () => this.setTheme('matrix'));
    document.getElementById('theme-system').addEventListener('click', () => this.setTheme('system'));

    // Notification settings
    document.getElementById('setting-notifications').addEventListener('change', (e) => {
      this.notificationsEnabled = e.target.checked;
      localStorage.setItem('battlePlanNotifications', e.target.checked);
      if (e.target.checked) {
        this.requestNotificationPermission();
      }
    });

    document.getElementById('notification-permission-btn').addEventListener('click', () => {
      this.requestNotificationPermission();
    });

    // Groq API Key settings
    document.getElementById('save-groq-key-btn').addEventListener('click', () => this.saveGroqApiKey());
    document.getElementById('test-groq-key-btn').addEventListener('click', () => this.testGroqApiKey());
    document.getElementById('setting-groq-api-key').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.saveGroqApiKey();
    });

    // Voice input buttons
    document.querySelectorAll('.voice-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const targetInput = btn.dataset.target;
        this.startVoiceInput(targetInput);
      });
    });

    // Edit Modal
    document.getElementById('edit-save-btn').addEventListener('click', () => this.saveEditItem());
    document.getElementById('edit-delete-btn').addEventListener('click', () => this.deleteEditItem());
    document.getElementById('edit-cancel-btn').addEventListener('click', () => this.closeEditModal());

    // Edit Modal - Subtasks
    document.getElementById('add-subtask-btn').addEventListener('click', () => this.addSubtask());
    document.getElementById('subtask-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.addSubtask();
    });

    // Edit Modal - Tag buttons
    document.querySelectorAll('.tag-btn').forEach(btn => {
      btn.addEventListener('click', () => this.selectTag(btn.dataset.tag));
    });

    // Edit Modal - Preset buttons
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => this.applyPreset(btn.dataset.preset));
    });

    // Edit Modal - Score buttons (ACE + LMT)
    document.querySelectorAll('.score-buttons').forEach(container => {
      const field = container.dataset.field;
      container.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => this.selectScore(field, parseInt(btn.dataset.value)));
      });
    });

    // Edit Modal - Bucket buttons
    document.querySelectorAll('.bucket-btn').forEach(btn => {
      btn.addEventListener('click', () => this.selectBucket(parseInt(btn.dataset.bucket)));
    });

    // Edit Modal - Confidence buttons
    document.querySelectorAll('.confidence-btn').forEach(btn => {
      btn.addEventListener('click', () => this.selectConfidence(btn.dataset.confidence));
    });

    // Edit Modal - Recurrence select
    document.getElementById('edit-recurrence').addEventListener('change', (e) => {
      const daySelect = document.getElementById('edit-recurrence-day');
      // Show day selector only for weekly recurrence
      daySelect.classList.toggle('hidden', e.target.value !== 'weekly');
    });

    // Actual Time Modal
    document.querySelectorAll('.actual-bucket-btn').forEach(btn => {
      btn.addEventListener('click', () => this.completeWithActualTime(parseInt(btn.dataset.bucket)));
    });
    document.getElementById('skip-actual-btn').addEventListener('click', () => this.skipActualTime());

    // Routine Modal
    document.getElementById('routine-item-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.addRoutineItem();
    });
    document.getElementById('routine-item-add-btn').addEventListener('click', () => this.addRoutineItem());
    document.getElementById('routine-save-btn').addEventListener('click', () => this.saveRoutine());
    document.getElementById('routine-delete-btn').addEventListener('click', () => this.deleteRoutine());
    document.getElementById('routine-cancel-btn').addEventListener('click', () => this.closeRoutineModal());

    // Import Confirmation Modal
    document.getElementById('import-confirm-btn').addEventListener('click', () => this.confirmImport());
    document.getElementById('import-cancel-btn').addEventListener('click', () => this.cancelImport());

    // Waiting Modal
    document.getElementById('waiting-confirm-btn').addEventListener('click', () => this.confirmWaiting());
    document.getElementById('waiting-cancel-btn').addEventListener('click', () => this.cancelWaiting());
    document.getElementById('waiting-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.confirmWaiting();
      if (e.key === 'Escape') this.cancelWaiting();
    });

    // Overdue Modal
    document.getElementById('hud-overdue').addEventListener('click', () => this.showOverdueModal());
    document.getElementById('overdue-reschedule-all-btn').addEventListener('click', () => this.rescheduleAllOverdue());
    document.getElementById('overdue-close-btn').addEventListener('click', () => this.closeOverdueModal());

    // Focus Mode
    document.getElementById('focus-pause-btn').addEventListener('click', () => this.toggleFocusPause());
    document.getElementById('focus-stop-btn').addEventListener('click', () => this.stopFocus());

    // Global keyboard shortcuts
    document.addEventListener('keydown', (e) => this.handleGlobalKeydown(e));

    // Close modals on backdrop click
    document.querySelectorAll('.overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.classList.add('hidden');
        }
      });
    });

    // Load capacity settings on init
    this.loadCapacitySettings();
  }

  async loadCapacitySettings() {
    // Capacity settings
    const weekday = await db.getSetting('weekday_capacity_minutes', 180);
    const weekend = await db.getSetting('weekend_capacity_minutes', 360);
    const slack = await db.getSetting('always_plan_slack_percent', 30);

    document.getElementById('setting-weekday-capacity').value = weekday;
    document.getElementById('setting-weekend-capacity').value = weekend;
    document.getElementById('setting-slack').value = slack;

    // Behavior settings
    const top3Clear = await db.getSetting('top3_auto_clear_daily', true);
    const swipeEnabled = await db.getSetting('enable_swipe_gestures', true);
    const swipeThreshold = await db.getSetting('swipe_threshold', 0.45);

    document.getElementById('setting-top3-clear').checked = top3Clear;
    document.getElementById('setting-swipe-gestures').checked = swipeEnabled;
    document.getElementById('setting-swipe-threshold').value = swipeThreshold.toString();

    // Load notification setting
    document.getElementById('setting-notifications').checked = this.notificationsEnabled;
    this.updateNotificationStatus();
  }

  // ==================== NAVIGATION ====================

  navigateTo(page, pushHistory = true) {
    // Clean up focus timer if leaving Today page
    if (this.currentPage === 'today' && page !== 'today' && this.focusTimer) {
      this.stopFocus();
    }

    this.currentPage = page;
    this.selectedItemId = null;

    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.page === page);
    });

    document.querySelectorAll('.page').forEach(p => {
      p.classList.toggle('active', p.id === `page-${page}`);
    });

    // Show/hide HUD based on page
    const hud = document.getElementById('hud');
    if (page === 'today') {
      hud.classList.remove('hidden');
    } else {
      hud.classList.add('hidden');
    }

    // Update browser history for Android back button support
    if (pushHistory) {
      history.pushState({ page }, '', `#${page}`);
    }

    this.render();
  }

  // Handle browser back/forward buttons
  handlePopState(event) {
    if (event.state && event.state.page) {
      this.navigateTo(event.state.page, false);
    } else {
      // Default to inbox if no state
      this.navigateTo('inbox', false);
    }
  }

  // ==================== HUD ====================

  invalidateHudCache() {
    this.hudCache = null;
    this.hudCacheTime = 0;
  }

  async updateHUD(forceRefresh = false) {
    const now = Date.now();

    // Use cache if valid and not forcing refresh
    if (!forceRefresh && this.hudCache && (now - this.hudCacheTime) < this.hudCacheTTL) {
      this.applyHudCache();
      return;
    }

    // Calculate fresh HUD data
    const stats = await db.getTodayStats();
    const usableCapacity = await db.getUsableCapacity();

    // Calculate buffered time for all today items
    const todayItems = await db.getTodayItems();
    let totalBuffered = 0;
    let monsterCount = 0;
    let ratedCount = 0;
    let unratedCount = 0;

    for (const item of todayItems) {
      if (db.isRated(item)) {
        ratedCount++;
        const buffered = await db.getBufferedMinutes(item);
        totalBuffered += buffered || 0;
        if (db.isMonster(item)) monsterCount++;
      } else {
        unratedCount++;
      }
    }

    // Urgency stats (across ALL non-done items)
    const allItems = await db.getAllItems();
    let dueOverdue = 0, dueCritical = 0, dueUrgent = 0, dueWarning = 0;

    for (const item of allItems) {
      const urgency = this.getDueUrgency(item);
      if (urgency.tier === 'urgency-overdue') dueOverdue++;
      else if (urgency.tier === 'urgency-critical') dueCritical++;
      else if (urgency.tier === 'urgency-urgent') dueUrgent++;
      else if (urgency.tier === 'urgency-warning') dueWarning++;
    }

    // Store in cache
    this.hudCache = {
      totalBuffered, usableCapacity, monsterCount, ratedCount, unratedCount,
      top3Count: stats.top3Count, overdueCount: stats.overdueCount,
      dueOverdue, dueCritical, dueUrgent, dueWarning
    };
    this.hudCacheTime = now;

    // Apply to DOM
    this.applyHudCache();
  }

  applyHudCache() {
    if (!this.hudCache) return;

    const { totalBuffered, usableCapacity, monsterCount, ratedCount, unratedCount,
            top3Count, overdueCount, dueOverdue, dueCritical, dueUrgent, dueWarning } = this.hudCache;

    document.getElementById('hud-buffered').textContent = totalBuffered;
    document.getElementById('hud-capacity').textContent = usableCapacity;
    document.getElementById('hud-top3-count').textContent = top3Count;
    document.getElementById('hud-monster-count').textContent = monsterCount;
    document.getElementById('hud-rated').textContent = ratedCount;
    document.getElementById('hud-unrated').textContent = unratedCount;

    // Monster visibility
    const monsterEl = document.getElementById('hud-monster');
    monsterEl.style.color = monsterCount > 0 ? 'var(--monster)' : '';

    // Overdue
    const overdueEl = document.getElementById('hud-overdue');
    const overdueCountEl = document.getElementById('hud-overdue-count');
    if (overdueCount > 0) {
      overdueEl.classList.remove('hidden');
      overdueCountEl.textContent = overdueCount;
    } else {
      overdueEl.classList.add('hidden');
    }

    // Capacity warning
    const warningEl = document.getElementById('capacity-warning');
    if (totalBuffered > usableCapacity) {
      warningEl.classList.remove('hidden');
    } else {
      warningEl.classList.add('hidden');
    }

    // Urgency row
    const totalDueItems = dueOverdue + dueCritical + dueUrgent + dueWarning;
    const urgencyRow = document.getElementById('hud-urgency-row');

    if (totalDueItems > 0) {
      urgencyRow.style.display = '';
      document.getElementById('hud-due-overdue-count').textContent = dueOverdue;
      document.getElementById('hud-due-critical-count').textContent = dueCritical;
      document.getElementById('hud-due-urgent-count').textContent = dueUrgent;
      document.getElementById('hud-due-warning-count').textContent = dueWarning;

      document.getElementById('hud-due-overdue').style.display = dueOverdue ? '' : 'none';
      document.getElementById('hud-due-critical').style.display = dueCritical ? '' : 'none';
      document.getElementById('hud-due-urgent').style.display = dueUrgent ? '' : 'none';
      document.getElementById('hud-due-warning').style.display = dueWarning ? '' : 'none';
    } else {
      urgencyRow.style.display = 'none';
    }
  }

  // ==================== RENDERING ====================

  async render() {
    switch (this.currentPage) {
      case 'inbox':
        await this.renderInbox();
        break;
      case 'today':
        await this.renderToday();
        await this.updateHUD();
        break;
      case 'tomorrow':
        await this.renderTomorrow();
        break;
      case 'next':
        await this.renderByStatus('next');
        break;
      case 'waiting':
        await this.renderByStatus('waiting');
        break;
      case 'someday':
        await this.renderByStatus('someday');
        break;
      case 'done':
        await this.renderByStatus('done');
        break;
      case 'routines':
        await this.renderRoutines();
        break;
      case 'analytics':
        await this.renderAnalytics();
        break;
    }
  }

  async getFilteredItems(items) {
    const countEl = document.getElementById('search-count');

    if (!this.searchQuery.trim()) {
      // Hide count when not searching
      if (countEl) countEl.classList.add('hidden');
      return items;
    }

    const query = this.searchQuery.toLowerCase().trim();

    // Always search across all items globally
    const allItems = await db.getAllItems();
    const filtered = allItems.filter(item =>
      item.status !== 'done' &&
      (item.text.toLowerCase().includes(query) ||
      (item.next_action && item.next_action.toLowerCase().includes(query)) ||
      (item.waiting_on && item.waiting_on.toLowerCase().includes(query)))
    );

    // Show search result count
    if (countEl) {
      countEl.textContent = `${filtered.length} found`;
      countEl.classList.remove('hidden');
    }

    return filtered;
  }

  async renderInbox() {
    try {
      let items = await db.getInboxItems();
      items = await this.getFilteredItems(items);

      const list = document.getElementById('inbox-list');

      // Sort by priority (rated items first, then by score, then newest)
      const sorted = this.sortByPriority(items);

      if (sorted.length === 0) {
        const msg = this.searchQuery
          ? 'No matching items. Try different keywords or check "Search all" to include done tasks.'
          : 'Inbox is empty. Add a task above to get started!';
        list.innerHTML = `<li class="empty-state"><p>${msg}</p></li>`;
        return;
      }

      list.innerHTML = sorted.map(item => this.renderItem(item, { showPills: true })).join('');
      this.bindItemEvents();
    } catch (err) {
      debugLog('error', 'Error rendering inbox', err);
      this.showToast('Error loading inbox');
    }
  }

  async renderToday() {
    try {
      let items = await db.getTodayItems();
      items = await this.getFilteredItems(items);

      const top3Items = items.filter(i => i.isTop3)
        .sort((a, b) => (a.top3Order || 0) - (b.top3Order || 0));

      // Sort other items by priority score + time sensitivity
      const otherItems = this.sortByPriority(items.filter(i => !i.isTop3));

      document.getElementById('top3-count').textContent = `(${top3Items.length}/3)`;

      // Top 3 list
      const top3List = document.getElementById('top3-list');
      if (top3Items.length === 0) {
        const hasRatedItems = otherItems.some(i => db.isRated(i));
        const msg = hasRatedItems
          ? 'Tap "Suggest Top 3" to auto-select your priorities for today'
          : 'Rate some tasks first (double-tap to edit), then use "Suggest Top 3"';
        top3List.innerHTML = `<li class="empty-state"><p>${msg}</p></li>`;
      } else {
        const top3Results = await Promise.allSettled(top3Items.map(async (item, index) =>
          await this.renderItemAsync(item, { isTop3: true, top3Number: index + 1 })
        ));
        const top3Html = top3Results
          .filter(r => r.status === 'fulfilled')
          .map(r => r.value);
        top3List.innerHTML = top3Html.join('');
      }

      // Other today items
      const todayList = document.getElementById('today-list');
      if (otherItems.length === 0) {
        const msg = this.searchQuery
          ? 'No matching items'
          : top3Items.length > 0
            ? 'Focus on your Top 3! Add more tasks from Inbox if needed.'
            : 'Go to Inbox and tap "Today" on tasks you want to work on today';
        todayList.innerHTML = `<li class="empty-state"><p>${msg}</p></li>`;
      } else {
        const otherResults = await Promise.allSettled(otherItems.map(async item =>
          await this.renderItemAsync(item, { showTop3Toggle: true })
        ));
        const otherHtml = otherResults
          .filter(r => r.status === 'fulfilled')
          .map(r => r.value);
        todayList.innerHTML = otherHtml.join('');
      }

      this.bindItemEvents();
    } catch (err) {
      debugLog('error', 'Error rendering today', err);
      this.showToast('Error loading today items');
    }
  }

  async renderTomorrow() {
    try {
      let items = await db.getTomorrowItems();
      items = await this.getFilteredItems(items);

      const list = document.getElementById('tomorrow-list');

      if (items.length === 0) {
        const msg = this.searchQuery ? 'No matching items' : 'Nothing scheduled for tomorrow';
        list.innerHTML = `<li class="empty-state"><p>${msg}</p></li>`;
        return;
      }

      // Sort by priority score + time sensitivity
      const sorted = this.sortByPriority(items);
      list.innerHTML = sorted.map(item => this.renderItem(item, { showPills: true })).join('');
      this.bindItemEvents();
    } catch (err) {
      debugLog('error', 'Error rendering tomorrow', err);
      this.showToast('Error loading tomorrow items');
    }
  }

  async renderByStatus(status) {
    try {
      let items;

      // Special handling for done status - filter archived items
      if (status === 'done') {
        items = await db.getDoneItems(this.showArchived);
      } else {
        items = await db.getItemsByStatus(status);
      }

      items = await this.getFilteredItems(items);

      const list = document.getElementById(`${status}-list`);

      if (items.length === 0) {
        let msg = this.searchQuery ? 'No matching items' : `No ${status} items`;
        if (status === 'done' && !this.showArchived) {
          msg = 'No recent completed tasks. Check "Show archived" to see older items.';
        }
        list.innerHTML = `<li class="empty-state"><p>${msg}</p></li>`;
        return;
      }

      // Sort by priority score + time sensitivity (done items by completion date)
      const sorted = status === 'done'
        ? items.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
        : this.sortByPriority(items);

      list.innerHTML = sorted.map(item => this.renderItem(item, { showPills: true })).join('');
      this.bindItemEvents();
    } catch (err) {
      debugLog('error', `Error rendering ${status}`, err);
      this.showToast(`Error loading ${status} items`);
    }
  }

  async archiveOldTasks() {
    try {
      const archived = await db.archiveDoneTasks(30);
      if (archived > 0) {
        this.showToast(`Archived ${archived} old task${archived > 1 ? 's' : ''}`);
        await this.renderByStatus('done');
      } else {
        this.showToast('No tasks older than 30 days to archive');
      }
    } catch (err) {
      debugLog('error', 'Error archiving tasks', err);
      this.showToast('Error archiving tasks');
    }
  }

  getDueUrgency(item) {
    if (!item.dueDate || item.status === 'done') return { tier: '', label: '', daysLeft: null };

    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const due = new Date(item.dueDate + 'T00:00:00');
    const diffMs = due - now;
    const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    if (daysLeft < 0) return { tier: 'urgency-overdue', label: `${Math.abs(daysLeft)}d overdue`, daysLeft };
    if (daysLeft === 0) return { tier: 'urgency-critical', label: 'Due today', daysLeft };
    if (daysLeft <= 3) return { tier: 'urgency-urgent', label: `${daysLeft}d left`, daysLeft };
    if (daysLeft <= 7) return { tier: 'urgency-warning', label: `${daysLeft}d left`, daysLeft };
    return { tier: '', label: `${daysLeft}d left`, daysLeft };
  }

  renderItem(item, options = {}) {
    const { showPills = false, isTop3 = false, top3Number = null, showTop3Toggle = false, subtaskProgress = null } = options;

    const statusClass = `status-${item.status}`;
    const selectedClass = item.id === this.selectedItemId ? 'selected' : '';
    const isOverdue = db.isOverdue(item);
    const overdueClass = isOverdue ? 'overdue' : '';
    const urgency = this.getDueUrgency(item);
    const urgencyClass = urgency.tier;

    // Handle date display - fallback to created field for older items
    const createdDate = new Date(item.created_at || item.created);
    const dateStr = isNaN(createdDate.getTime()) ? '' : createdDate.toLocaleDateString();

    // Calculate scores
    const scores = db.calculateScores(item);
    const badges = db.calculateBadges(item);
    const isRated = db.isRated(item);

    // Build badges HTML
    let badgesHtml = '';
    if (badges.length > 0) {
      badgesHtml = `<div class="badges">${badges.map(b =>
        `<span class="badge badge-${b.toLowerCase()}">${b}</span>`
      ).join('')}</div>`;
    }

    // Build meta HTML
    let metaHtml = '';

    if (scores.priority_score !== null) {
      metaHtml += `<span class="item-score">Score: ${scores.priority_score}</span>`;
    }

    if (item.estimate_bucket) {
      const bucketLabel = item.estimate_bucket >= 60
        ? `${item.estimate_bucket / 60}h`
        : `${item.estimate_bucket}m`;
      metaHtml += `<span class="item-bucket">${bucketLabel}</span>`;
    }

    if (item.tag) {
      metaHtml += `<span class="tag tag-${item.tag}">${item.tag}</span>`;
    }

    if (item.recurrence) {
      const recurrenceLabel = item.recurrence === 'daily' ? 'Daily' : item.recurrence === 'weekly' ? 'Weekly' : 'Monthly';
      metaHtml += `<span class="recurring-badge">${recurrenceLabel}</span>`;
    }

    if (item.notes) {
      metaHtml += `<span class="notes-badge">Notes</span>`;
    }

    if (subtaskProgress) {
      const isComplete = subtaskProgress.completed === subtaskProgress.total;
      metaHtml += `<span class="subtask-progress ${isComplete ? 'complete' : ''}">${subtaskProgress.completed}/${subtaskProgress.total}</span>`;
    }

    if (dateStr) {
      metaHtml += `<span class="item-date">${dateStr}</span>`;
    }

    if (item.scheduled_for_date) {
      metaHtml += `<span class="item-scheduled">Scheduled: ${item.scheduled_for_date}</span>`;
    }
    if (item.dueDate) {
      const dueColorClass = urgency.tier ? `due-${urgency.tier.replace('urgency-', '')}` : '';
      const dueLabel = urgency.label ? ` (${urgency.label})` : '';
      metaHtml += `<span class="due-date ${dueColorClass}">Due: ${item.dueDate}${dueLabel}</span>`;
    }

    // Waiting on badge
    let waitingOnHtml = '';
    if (item.status === 'waiting' && item.waiting_on) {
      waitingOnHtml = `<div class="waiting-on-badge">${this.escapeHtml(item.waiting_on)}</div>`;
    }

    // Next action
    let nextActionHtml = '';
    if (item.next_action) {
      nextActionHtml = `<div class="item-next-action">${this.escapeHtml(item.next_action)}</div>`;
    }

    let pillsHtml = '';
    if (showPills) {
      pillsHtml = `
        <div class="status-pills">
          <button class="pill pill-today ${item.status === 'today' ? 'active' : ''}" data-status="today">Today</button>
          <button class="pill pill-tomorrow ${item.status === 'tomorrow' ? 'active' : ''}" data-status="tomorrow">Tomorrow</button>
          <button class="pill pill-next ${item.status === 'next' ? 'active' : ''}" data-status="next">Next</button>
          <button class="pill pill-waiting ${item.status === 'waiting' ? 'active' : ''}" data-status="waiting">Waiting</button>
          <button class="pill pill-someday ${item.status === 'someday' ? 'active' : ''}" data-status="someday">Someday</button>
          <button class="pill pill-done ${item.status === 'done' ? 'active' : ''}" data-status="done">Done</button>
        </div>
      `;
    }

    // Action buttons for Today view (Done, Top 3 toggle, Reschedule)
    let actionsHtml = '';
    if (showTop3Toggle || isTop3) {
      const top3BtnClass = (item.isTop3 || isTop3) ? 'in-top3' : '';
      const top3BtnText = (item.isTop3 || isTop3) ? '- Top 3' : '+ Top 3';
      actionsHtml = `
        <div class="item-actions">
          <button class="done-btn">Done</button>
          <button class="tomorrow-btn">→ Tomorrow</button>
          <button class="top3-toggle ${top3BtnClass}">${top3BtnText}</button>
        </div>
      `;
    }

    // Swipe action trays (hidden by default, revealed on swipe)
    const swipeRightTray = `
      <div class="swipe-tray swipe-tray-right">
        <button class="swipe-action swipe-done" data-action="done">Done</button>
        <button class="swipe-action swipe-tomorrow" data-action="tomorrow">Tomorrow</button>
        <button class="swipe-action swipe-edit" data-action="edit">Edit</button>
      </div>
    `;
    const swipeLeftTray = `
      <div class="swipe-tray swipe-tray-left">
        <button class="swipe-action swipe-edit" data-action="edit">Edit</button>
        <button class="swipe-action swipe-tomorrow" data-action="tomorrow">Tomorrow</button>
      </div>
    `;

    return `
      <li class="item-wrapper" data-id="${item.id}">
        ${swipeLeftTray}
        <div class="item ${statusClass} ${selectedClass} ${overdueClass} ${urgencyClass}" data-id="${item.id}">
          ${top3Number ? `<span class="top3-badge">${top3Number}${item.top3Locked ? '<span class="lock-icon" title="Locked - survives daily reset">🔒</span>' : ''}</span>` : ''}
          <div class="item-header">
            <div class="item-text">${this.highlightSearch(item.text)}</div>
            ${isOverdue ? '<span class="badge badge-overdue">Overdue</span>' : ''}
          </div>
          ${nextActionHtml}
          ${waitingOnHtml}
          ${badgesHtml}
          <div class="item-meta">
            ${metaHtml}
          </div>
          ${pillsHtml}
          ${actionsHtml}
        </div>
        ${swipeRightTray}
      </li>
    `;
  }

  async renderItemAsync(item, options = {}) {
    // Fetch subtask progress if this item might have subtasks
    if (!item.parent_id) {
      const progress = await db.getSubtaskProgress(item.id);
      if (progress) {
        options.subtaskProgress = progress;
      }
    }
    return this.renderItem(item, options);
  }

  bindItemEvents() {
    // Click to select
    document.querySelectorAll('.item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('pill') ||
            e.target.classList.contains('top3-toggle') ||
            e.target.classList.contains('swipe-action')) return;
        this.selectItem(item.dataset.id);
      });

      // Double click to edit
      item.addEventListener('dblclick', () => {
        this.openEditModal(item.dataset.id);
      });
    });

    // Status pills
    document.querySelectorAll('.pill').forEach(pill => {
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        const itemId = pill.closest('.item').dataset.id;
        const status = pill.dataset.status;
        this.setItemStatus(itemId, status);
      });
    });

    // Top 3 toggle
    document.querySelectorAll('.top3-toggle').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const itemId = btn.closest('.item').dataset.id;
        const item = await db.getItem(itemId);
        const result = await db.setTop3(itemId, !item.isTop3);
        if (result && result.error) {
          alert(result.message || result.error);
        } else {
          this.render();
          this.updateHUD();
        }
      });
    });

    // Done button
    document.querySelectorAll('.done-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const itemId = btn.closest('.item').dataset.id;
        await this.setItemStatus(itemId, 'done');
      });
    });

    // Tomorrow button (reschedule)
    document.querySelectorAll('.tomorrow-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const itemId = btn.closest('.item').dataset.id;
        await db.setTomorrow(itemId);
        await this.render();
        await this.updateHUD();
      });
    });

    // Swipe action tray buttons
    document.querySelectorAll('.swipe-action').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const wrapper = btn.closest('.item-wrapper');
        const itemId = wrapper.dataset.id;
        const action = btn.dataset.action;
        await this.handleSwipeAction(itemId, action, wrapper);
      });
    });

    // Bind swipe gestures if enabled
    if (this.swipeEnabled) {
      this.bindSwipeGestures();
    }
  }

  // ==================== SWIPE GESTURES ====================

  bindSwipeGestures() {
    document.querySelectorAll('.item-wrapper').forEach(wrapper => {
      const item = wrapper.querySelector('.item');
      if (!item) return;

      // Use pointer events for unified touch/mouse handling
      item.addEventListener('touchstart', (e) => this.handleSwipeStart(e, wrapper), { passive: true });
      item.addEventListener('touchmove', (e) => this.handleSwipeMove(e, wrapper), { passive: false });
      item.addEventListener('touchend', (e) => this.handleSwipeEnd(e, wrapper));
      item.addEventListener('touchcancel', (e) => this.handleSwipeCancel(wrapper));
    });
  }

  handleSwipeStart(e, wrapper) {
    if (!this.swipeEnabled) return;

    const touch = e.touches[0];
    const item = wrapper.querySelector('.item');
    const rect = item.getBoundingClientRect();

    this.swipeState = {
      wrapper,
      item,
      startX: touch.clientX,
      startY: touch.clientY,
      currentX: 0,
      cardWidth: rect.width,
      isScrolling: null, // null = undecided, true = vertical scroll, false = horizontal swipe
      trayRevealed: false
    };

    item.style.transition = 'none';
  }

  handleSwipeMove(e, wrapper) {
    if (!this.swipeState || this.swipeState.wrapper !== wrapper) return;

    const touch = e.touches[0];
    const dx = touch.clientX - this.swipeState.startX;
    const dy = touch.clientY - this.swipeState.startY;

    // Determine scroll direction on first significant move
    if (this.swipeState.isScrolling === null) {
      // Use 10px threshold to decide
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        // Vertical scroll - cancel swipe and allow scroll
        this.swipeState.isScrolling = true;
        return;
      } else if (Math.abs(dx) > 10) {
        // Horizontal swipe - prevent scroll
        this.swipeState.isScrolling = false;
      }
    }

    // If scrolling vertically, don't interfere
    if (this.swipeState.isScrolling === true) {
      return;
    }

    // Prevent vertical scroll when swiping horizontally
    if (this.swipeState.isScrolling === false) {
      e.preventDefault();
    }

    // Calculate swipe percentage
    const swipePercent = Math.abs(dx) / this.swipeState.cardWidth;
    this.swipeState.currentX = dx;

    // Apply transform to the item
    const item = this.swipeState.item;
    item.style.transform = `translateX(${dx}px)`;

    // Show/hide action trays based on direction
    const rightTray = wrapper.querySelector('.swipe-tray-right');
    const leftTray = wrapper.querySelector('.swipe-tray-left');

    if (dx > 0) {
      // Swiping right
      rightTray.classList.add('visible');
      leftTray.classList.remove('visible');

      // Visual feedback for full swipe threshold
      if (swipePercent >= this.swipeThreshold) {
        item.classList.add('swipe-threshold');
      } else {
        item.classList.remove('swipe-threshold');
      }
    } else if (dx < 0) {
      // Swiping left
      leftTray.classList.add('visible');
      rightTray.classList.remove('visible');

      if (swipePercent >= this.swipeThreshold) {
        item.classList.add('swipe-threshold');
      } else {
        item.classList.remove('swipe-threshold');
      }
    }

    // Mark tray as revealed if past 20%
    if (swipePercent >= 0.2) {
      this.swipeState.trayRevealed = true;
    }
  }

  handleSwipeEnd(e, wrapper) {
    if (!this.swipeState || this.swipeState.wrapper !== wrapper) return;

    const { item, currentX, cardWidth } = this.swipeState;
    const swipePercent = Math.abs(currentX) / cardWidth;
    const swipeRight = currentX > 0;

    item.style.transition = 'transform 0.2s ease-out';
    item.classList.remove('swipe-threshold');

    // Full swipe (>= 60%) - execute action immediately
    if (swipePercent >= this.swipeThreshold) {
      const itemId = wrapper.dataset.id;

      // Haptic feedback if available
      if (navigator.vibrate) {
        navigator.vibrate(10);
      }

      if (swipeRight) {
        // Full swipe right = Done
        this.animateSwipeOut(wrapper, 'right').then(() => {
          this.setItemStatus(itemId, 'done');
        });
      } else {
        // Full swipe left = Tomorrow (with undo support)
        this.animateSwipeOut(wrapper, 'left').then(async () => {
          await this.saveForUndo(itemId, 'Moved to Tomorrow');
          await db.setTomorrow(itemId);
          await this.render();
          await this.updateHUD();
          this.showUndoToast('Moved to Tomorrow');
        });
      }
    }
    // Partial swipe (20-60%) - leave tray visible
    else if (swipePercent >= 0.2) {
      // Snap to reveal tray position
      const revealDistance = swipeRight ? 120 : -120;
      item.style.transform = `translateX(${revealDistance}px)`;
      wrapper.classList.add('tray-open');

      // Add click-outside listener to close
      this.addTrayCloseListener(wrapper);
    }
    // Small swipe (< 20%) - snap back
    else {
      this.resetSwipe(wrapper);
    }

    this.swipeState = null;
  }

  handleSwipeCancel(wrapper) {
    if (this.swipeState && this.swipeState.wrapper === wrapper) {
      this.resetSwipe(wrapper);
      this.swipeState = null;
    }
  }

  resetSwipe(wrapper) {
    const item = wrapper.querySelector('.item');
    const rightTray = wrapper.querySelector('.swipe-tray-right');
    const leftTray = wrapper.querySelector('.swipe-tray-left');

    item.style.transition = 'transform 0.2s ease-out';
    item.style.transform = 'translateX(0)';
    item.classList.remove('swipe-threshold');
    rightTray.classList.remove('visible');
    leftTray.classList.remove('visible');
    wrapper.classList.remove('tray-open');
  }

  animateSwipeOut(wrapper, direction) {
    return new Promise(resolve => {
      const item = wrapper.querySelector('.item');
      const distance = direction === 'right' ? window.innerWidth : -window.innerWidth;

      item.style.transition = 'transform 0.3s ease-out, opacity 0.3s ease-out';
      item.style.transform = `translateX(${distance}px)`;
      item.style.opacity = '0';

      setTimeout(() => {
        wrapper.style.height = wrapper.offsetHeight + 'px';
        wrapper.style.transition = 'height 0.2s ease-out, opacity 0.2s ease-out';
        wrapper.style.height = '0';
        wrapper.style.overflow = 'hidden';
        wrapper.style.opacity = '0';

        setTimeout(resolve, 200);
      }, 300);
    });
  }

  addTrayCloseListener(wrapper) {
    // Remove old handler first to prevent memory leaks
    if (this.trayCloseHandler) {
      document.removeEventListener('click', this.trayCloseHandler);
      document.removeEventListener('touchstart', this.trayCloseHandler);
    }

    const closeHandler = (e) => {
      // Check if click is outside the wrapper
      if (!wrapper.contains(e.target)) {
        this.resetSwipe(wrapper);
        document.removeEventListener('click', closeHandler);
        document.removeEventListener('touchstart', closeHandler);
        this.trayCloseHandler = null;
      }
    };

    this.trayCloseHandler = closeHandler;

    // Delay adding listener to avoid immediate trigger
    setTimeout(() => {
      document.addEventListener('click', closeHandler);
      document.addEventListener('touchstart', closeHandler, { passive: true });
    }, 100);
  }

  async handleSwipeAction(itemId, action, wrapper) {
    // Close the tray first
    this.resetSwipe(wrapper);

    switch (action) {
      case 'done':
        await this.setItemStatus(itemId, 'done');
        break;
      case 'tomorrow':
        await this.saveForUndo(itemId, 'Moved to Tomorrow');
        await db.setTomorrow(itemId);
        await this.render();
        await this.updateHUD();
        this.showUndoToast('Moved to Tomorrow');
        break;
      case 'edit':
        this.openEditModal(itemId);
        break;
    }
  }

  // ==================== VOICE INPUT ====================

  initVoiceInput() {
    const globalVoiceBtn = document.getElementById('global-voice-btn');

    if (!this.voiceSupported) {
      // Hide mic buttons if not supported
      document.querySelectorAll('.voice-btn').forEach(btn => {
        btn.style.display = 'none';
      });
      if (globalVoiceBtn) {
        globalVoiceBtn.classList.add('hidden');
      }
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.speechRecognition = new SpeechRecognition();
    this.speechRecognition.continuous = false;
    this.speechRecognition.interimResults = false;
    this.speechRecognition.lang = 'en-US';

    this.speechRecognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      this.handleVoiceResult(transcript);
    };

    this.speechRecognition.onerror = (event) => {
      debugLog('error', 'Speech recognition error', event.error);
      this.stopVoiceInput();

      let message = 'Voice input error';
      if (event.error === 'not-allowed') {
        message = 'Microphone access denied';
      } else if (event.error === 'no-speech') {
        message = 'No speech detected';
      } else if (event.error === 'network') {
        message = 'Voice requires internet connection';
      }
      this.showToast(message);
    };

    this.speechRecognition.onend = () => {
      this.stopVoiceInput();
    };

    // Set up global voice button
    if (globalVoiceBtn) {
      globalVoiceBtn.addEventListener('click', () => {
        this.startGlobalVoice();
      });
    }
  }

  startGlobalVoice() {
    if (!this.voiceSupported || !this.speechRecognition) {
      this.showToast('Voice not supported');
      return;
    }

    // Toggle if already listening
    if (this.isListening) {
      this.stopVoiceInput();
      this.showToast('Voice stopped');
      return;
    }

    // Start listening without a specific input target
    this.currentVoiceTarget = null;
    this.startVoiceInput(null);

    // Update global button state
    const globalBtn = document.getElementById('global-voice-btn');
    if (globalBtn) {
      globalBtn.classList.add('listening');
    }
  }

  startVoiceInput(targetInputId) {
    if (!this.voiceSupported || !this.speechRecognition) {
      this.showToast('Voice input not supported in this browser');
      return;
    }

    // Prevent race condition from rapid clicks
    if (this.isListening || this.voiceStartLock) {
      if (this.isListening) {
        this.stopVoiceInput();
        this.showToast('Voice input stopped');
      }
      return;
    }

    // Lock to prevent double-start
    this.voiceStartLock = true;
    this.isListening = true;
    this.currentVoiceTarget = targetInputId;

    // Update button state
    const btn = document.querySelector(`.voice-btn[data-target="${targetInputId}"]`);
    if (btn) {
      btn.classList.add('listening');
    }

    // Show listening indicator
    this.showToast('Listening...', 'listening');

    try {
      this.speechRecognition.start();
    } catch (err) {
      debugLog('error', 'Failed to start speech recognition', err);
      this.stopVoiceInput();
      this.showToast('Failed to start voice input');
    } finally {
      // Note: voiceStartLock is released in stopVoiceInput()
      // which is called by onend handler - this prevents race conditions
    }
  }

  stopVoiceInput() {
    this.isListening = false;
    this.voiceStartLock = false; // Release lock here, after speech ends

    // Update all voice buttons (inline and global)
    document.querySelectorAll('.voice-btn').forEach(btn => {
      btn.classList.remove('listening');
    });

    // Update global voice button
    const globalBtn = document.getElementById('global-voice-btn');
    if (globalBtn) {
      globalBtn.classList.remove('listening');
    }

    // Hide listening toast
    this.hideToast();

    try {
      this.speechRecognition?.stop();
    } catch (err) {
      // Ignore errors when stopping
    }
  }

  async handleVoiceResult(transcript) {
    const trimmed = transcript.trim();

    // Show processing indicator
    this.showToast('Processing...', 'listening');

    // Get context for AI
    const context = await this.getVoiceContext();

    // Use Groq to parse the intent
    const parsed = await groqAssistant.parseIntent(trimmed, context);

    debugLog('log', 'Groq parsed intent:', parsed);

    // Execute based on intent
    await this.executeAICommand(parsed, trimmed);

    this.stopVoiceInput();
  }

  async getVoiceContext() {
    try {
      const todayItems = await db.getTodayItems();
      const inboxItems = await db.getInboxItems();
      const top3Items = await db.getTop3Items();
      const routines = await db.getAllRoutines();

      return {
        currentPage: this.currentPage,
        todayCount: todayItems.length,
        inboxCount: inboxItems.length,
        top3Count: top3Items.length,
        routines: routines.map(r => r.name)
      };
    } catch (err) {
      debugLog('error', 'Error getting voice context', err);
      return { currentPage: this.currentPage };
    }
  }

  async executeAICommand(parsed, originalText) {
    const { intent, data } = parsed;

    switch (intent) {
      case 'add_task':
        await this.voiceAddTask(data);
        break;

      case 'complete_task':
        await this.voiceCompleteTask(data.keyword);
        break;

      case 'move_task':
        await this.voiceMoveTask(data);
        break;

      case 'find_task':
        await this.voiceFindTask(data.keyword);
        break;

      case 'navigate':
        await this.voiceNavigate(data.page);
        break;

      case 'run_routine':
        await this.voiceRunRoutine(data.routine_name);
        break;

      case 'get_stats':
        await this.voiceGetStats(data.stat_type, originalText);
        break;

      case 'start_focus':
        this.startFocus(data.minutes);
        this.showToast(`Focus mode started${data.minutes ? ` for ${data.minutes} min` : ''}`);
        break;

      case 'stop_focus':
        this.stopFocus();
        this.showToast('Focus mode stopped');
        break;

      case 'help':
        this.showToast('Try: "add task...", "go to today", "how many tasks today?"');
        break;

      case 'unknown':
      default:
        // Fall back to inserting as task text or into input
        await this.voiceFallback(originalText);
        break;
    }
  }

  async voiceAddTask(data) {
    if (!data.text) {
      this.showToast('What task would you like to add?');
      return;
    }

    const item = await db.addItem(data.text);

    // Apply any extracted data
    const updates = {};
    if (data.scheduled_date) {
      updates.scheduled_for_date = data.scheduled_date;
      updates.status = data.scheduled_date === db.getToday() ? 'today' : 'tomorrow';
    }
    if (data.due_date) {
      updates.dueDate = data.due_date;
    }
    if (data.estimate_minutes) {
      updates.estimate_bucket = data.estimate_minutes;
      updates.confidence = 'medium'; // Default confidence for voice-added
    }

    if (Object.keys(updates).length > 0) {
      await db.updateItem(item.id, updates);
    }

    await this.render();
    await this.updateHUD();

    let msg = `Added: ${data.text.substring(0, 25)}`;
    if (data.scheduled_date) msg += ` (${data.scheduled_date === db.getToday() ? 'today' : data.scheduled_date})`;
    this.showToast(msg);
  }

  async voiceCompleteTask(keyword) {
    if (!keyword) {
      this.showToast('Which task should I complete?');
      return;
    }

    const item = await this.findItemByKeyword(keyword);
    if (item) {
      await this.setItemStatus(item.id, 'done');
      this.showToast(`Done: ${item.text.substring(0, 25)}...`);
    } else {
      this.showToast(`No task found matching "${keyword}"`);
    }
  }

  async voiceMoveTask(data) {
    if (!data.keyword) {
      this.showToast('Which task should I move?');
      return;
    }

    const item = await this.findItemByKeyword(data.keyword);
    if (!item) {
      this.showToast(`No task found matching "${data.keyword}"`);
      return;
    }

    if (data.target_name === 'tomorrow' || data.target_date === db.getTomorrow()) {
      await db.setTomorrow(item.id);
      this.showToast(`Moved to tomorrow: ${item.text.substring(0, 20)}...`);
    } else if (data.target_name === 'today' || data.target_date === db.getToday()) {
      await db.setToday(item.id);
      this.showToast(`Moved to today: ${item.text.substring(0, 20)}...`);
    } else if (data.target_date) {
      await db.updateItem(item.id, { scheduled_for_date: data.target_date });
      this.showToast(`Scheduled for ${data.target_date}: ${item.text.substring(0, 20)}...`);
    }

    await this.render();
    await this.updateHUD();
  }

  async voiceFindTask(keyword) {
    if (!keyword) {
      this.showToast('What task are you looking for?');
      return;
    }

    const items = await db.getAllItems();
    const lower = keyword.toLowerCase();
    const matches = items.filter(item =>
      item.status !== 'done' &&
      (item.text.toLowerCase().includes(lower) ||
       (item.next_action && item.next_action.toLowerCase().includes(lower)))
    );

    if (matches.length === 0) {
      this.showToast(`No tasks found for "${keyword}"`);
    } else if (matches.length === 1) {
      const item = matches[0];
      const location = item.status === 'today' ? 'Today' :
                       item.status === 'inbox' ? 'Inbox' :
                       item.status === 'tomorrow' ? 'Tomorrow' : item.status;
      this.showToast(`Found in ${location}: ${item.text.substring(0, 30)}`);
      // Navigate to the item's location
      if (['inbox', 'today', 'tomorrow'].includes(item.status)) {
        this.navigateTo(item.status);
      }
    } else {
      this.showToast(`Found ${matches.length} tasks matching "${keyword}"`);
    }
  }

  async voiceNavigate(page) {
    const pageMap = {
      'inbox': 'inbox',
      'today': 'today',
      'tomorrow': 'tomorrow',
      'done': 'done',
      'completed': 'done',
      'routines': 'routines',
      'routine': 'routines',
      'settings': 'settings',
      'config': 'settings'
    };

    const targetPage = pageMap[page?.toLowerCase()] || page;

    if (targetPage && ['inbox', 'today', 'tomorrow', 'done', 'routines', 'settings'].includes(targetPage)) {
      this.navigateTo(targetPage);
      this.showToast(`Navigated to ${targetPage}`);
    } else {
      this.showToast(`Unknown page: ${page}`);
    }
  }

  async voiceRunRoutine(routineName) {
    if (!routineName) {
      this.showToast('Which routine should I run?');
      return;
    }

    const routines = await db.getAllRoutines();
    const lower = routineName.toLowerCase();

    // Find routine by name (fuzzy match)
    const routine = routines.find(r =>
      r.name.toLowerCase().includes(lower) ||
      lower.includes(r.name.toLowerCase())
    );

    if (!routine) {
      const names = routines.map(r => r.name).join(', ');
      this.showToast(`Routine not found. Available: ${names || 'none'}`);
      return;
    }

    if (routine.items.length === 0) {
      this.showToast(`${routine.name} has no items`);
      return;
    }

    await db.runRoutine(routine.id);
    this.navigateTo('today');
    this.showToast(`Added ${routine.items.length} items from ${routine.name}`);
  }

  async voiceGetStats(statType, originalQuery) {
    const stats = await this.gatherFullStats();

    // Use AI to generate natural response
    const response = await groqAssistant.generateStatsResponse(stats, originalQuery);

    // Show stats with longer duration (6 seconds)
    this.showToast(response, 'info', 6000);
  }

  async gatherFullStats() {
    const todayItems = await db.getTodayItems();
    const inboxItems = await db.getInboxItems();
    const tomorrowItems = await db.getTomorrowItems();
    const top3Stats = await db.getTop3Stats();
    const allItems = await db.getAllItems();

    const completedToday = allItems.filter(i => {
      if (i.status !== 'done' || !i.updated_at) return false;
      const doneDate = i.updated_at.split('T')[0];
      return doneDate === db.getToday();
    }).length;

    const overdueCount = allItems.filter(i => db.isOverdue(i)).length;

    return {
      todayCount: todayItems.length,
      completedToday,
      inboxCount: inboxItems.length,
      tomorrowCount: tomorrowItems.length,
      top3Count: top3Stats.top3Count,
      top3Minutes: top3Stats.totalBuffered,
      capacity: top3Stats.usableCapacity,
      freeTime: Math.max(0, top3Stats.usableCapacity - top3Stats.totalBuffered),
      overdueCount
    };
  }

  async voiceFallback(text) {
    // If on a page with an input, insert the text
    const input = document.getElementById(this.currentVoiceTarget);
    if (input) {
      if (input.value.trim()) {
        input.value = input.value.trim() + ' ' + text;
      } else {
        input.value = text;
      }
      input.focus();
      this.showToast('Added text to input');
      return;
    }

    // Otherwise, add as a new task
    await db.addItem(text);
    await this.render();
    this.showToast(`Added task: ${text.substring(0, 25)}...`);
  }

  async findItemByKeyword(keyword) {
    // Search in current view first, then all items
    let items;
    if (this.currentPage === 'today') {
      items = await db.getTodayItems();
    } else if (this.currentPage === 'inbox') {
      items = await db.getInboxItems();
    } else {
      items = await db.getAllItems();
    }

    const lower = keyword.toLowerCase();

    // First try exact-ish match in current view
    let found = items.find(item =>
      item.status !== 'done' &&
      (item.text.toLowerCase().includes(lower) ||
       (item.next_action && item.next_action.toLowerCase().includes(lower)))
    );

    // If not found in current view, search all items
    if (!found) {
      const allItems = await db.getAllItems();
      found = allItems.find(item =>
        item.status !== 'done' &&
        (item.text.toLowerCase().includes(lower) ||
         (item.next_action && item.next_action.toLowerCase().includes(lower)))
      );
    }

    return found;
  }

  showToast(message, type = 'info', duration = 3000) {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.className = `toast toast-${type} visible`;

    // Auto-hide after duration (unless it's listening)
    if (type !== 'listening') {
      setTimeout(() => this.hideToast(), duration);
    }
  }

  hideToast() {
    const toast = document.getElementById('toast');
    if (toast) {
      toast.classList.remove('visible');
    }
    // Clear countdown interval if active
    if (this.undoCountdownInterval) {
      clearInterval(this.undoCountdownInterval);
      this.undoCountdownInterval = null;
    }
  }

  // ==================== UNDO ====================

  async saveForUndo(itemId, description, type = 'move') {
    const item = await db.getItem(itemId);
    if (item) {
      this.lastAction = {
        type,
        itemId,
        previousState: { ...item },
        description,
        timestamp: Date.now()
      };
    }
  }

  async saveDeleteForUndo(itemId, description, subtasks = []) {
    const item = await db.getItem(itemId);
    if (item) {
      this.lastAction = {
        type: 'delete',
        itemId,
        previousState: { ...item },
        deletedSubtasks: subtasks.map(s => ({ ...s })),
        description,
        timestamp: Date.now()
      };
    }
  }

  showUndoToast(message) {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      document.body.appendChild(toast);
    }

    let countdown = 5;

    // Build toast content safely (no inline handlers)
    const messageSpan = document.createElement('span');
    messageSpan.textContent = message;

    const undoBtn = document.createElement('button');
    undoBtn.className = 'undo-btn';
    undoBtn.textContent = `Undo (${countdown}s)`;
    undoBtn.addEventListener('click', () => this.undo());

    toast.innerHTML = '';
    toast.appendChild(messageSpan);
    toast.appendChild(undoBtn);
    toast.className = 'toast toast-undo visible';

    // Clear previous timeout and interval
    if (this.undoTimeout) clearTimeout(this.undoTimeout);
    if (this.undoCountdownInterval) clearInterval(this.undoCountdownInterval);

    // Update countdown every second
    this.undoCountdownInterval = setInterval(() => {
      countdown--;
      if (undoBtn && countdown > 0) {
        undoBtn.textContent = `Undo (${countdown}s)`;
      }
    }, 1000);

    // Auto-hide after 5 seconds
    this.undoTimeout = setTimeout(() => {
      if (this.undoCountdownInterval) clearInterval(this.undoCountdownInterval);
      this.hideToast();
      this.lastAction = null;
    }, CONSTANTS.UNDO_TIMEOUT_MS);
  }

  async undo() {
    this.invalidateHudCache(); // Data is changing
    if (!this.lastAction) {
      this.showToast('Nothing to undo');
      return;
    }

    const { type, itemId, previousState, deletedSubtasks } = this.lastAction;

    if (type === 'delete') {
      // Restore deleted item
      await db.restoreItem(previousState);
      // Restore any deleted subtasks
      if (deletedSubtasks && deletedSubtasks.length > 0) {
        for (const subtask of deletedSubtasks) {
          await db.restoreItem(subtask);
        }
      }
    } else {
      // Restore the previous state (for moves)
      await db.updateItem(itemId, previousState);
    }

    this.hideToast();
    this.lastAction = null;
    this.showToast('Undone!');

    await this.render();
    await this.updateHUD();
  }

  // ==================== NOTIFICATIONS ====================

  async requestNotificationPermission() {
    if (!('Notification' in window)) {
      this.showToast('Notifications not supported in this browser');
      return;
    }

    const permission = await Notification.requestPermission();
    this.updateNotificationStatus();

    if (permission === 'granted') {
      this.showToast('Notifications enabled!');
      // Start checking for due tasks
      this.checkDueNotifications();
    } else if (permission === 'denied') {
      this.showToast('Notifications blocked. Check browser settings.');
      document.getElementById('setting-notifications').checked = false;
      this.notificationsEnabled = false;
      localStorage.setItem('battlePlanNotifications', 'false');
    }
  }

  updateNotificationStatus() {
    const statusEl = document.getElementById('notification-status');
    const btnEl = document.getElementById('notification-permission-btn');

    if (!('Notification' in window)) {
      statusEl.textContent = 'Not supported';
      btnEl.style.display = 'none';
      return;
    }

    const permission = Notification.permission;
    if (permission === 'granted') {
      statusEl.textContent = 'Enabled';
      btnEl.style.display = 'none';
    } else if (permission === 'denied') {
      statusEl.textContent = 'Blocked';
      btnEl.textContent = 'Check Browser Settings';
    } else {
      statusEl.textContent = '';
      btnEl.textContent = 'Enable Browser Notifications';
    }
  }

  async checkDueNotifications() {
    if (!this.notificationsEnabled || Notification.permission !== 'granted') {
      return;
    }

    const today = new Date().toISOString().split('T')[0];

    // Only check once per day
    if (this.lastNotificationCheck === today) {
      return;
    }
    this.lastNotificationCheck = today;

    const items = await db.getAllItems();
    const urgentTasks = items.filter(item => {
      if (item.status === 'done' || !item.dueDate) return false;
      const daysUntil = this.getDaysUntilDue(item.dueDate);
      return daysUntil !== null && daysUntil <= 3 && daysUntil >= 0;
    });

    if (urgentTasks.length > 0) {
      const taskList = urgentTasks.slice(0, 3).map(t => `• ${t.text}`).join('\n');
      const moreText = urgentTasks.length > 3 ? `\n...and ${urgentTasks.length - 3} more` : '';

      new Notification('Battle Plan - Due Soon', {
        body: `${urgentTasks.length} task(s) due within 3 days:\n${taskList}${moreText}`,
        icon: '/reaperslawnservice/icons/icon.svg',
        tag: 'due-reminder'
      });
    }
  }

  getDaysUntilDue(dueDate) {
    if (!dueDate) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(dueDate + 'T00:00:00');
    const diffTime = due.getTime() - today.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  selectItem(id) {
    this.selectedItemId = this.selectedItemId === id ? null : id;
    document.querySelectorAll('.item').forEach(item => {
      item.classList.toggle('selected', item.dataset.id === this.selectedItemId);
    });
  }

  // ==================== INBOX OPERATIONS ====================

  async handleInboxKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      await this.addInboxItem();
    }
  }

  async addInboxItem() {
    const input = document.getElementById('inbox-input');
    const text = input.value.trim();
    if (!text) return;

    // Validate input length
    if (text.length > CONSTANTS.MAX_TASK_LENGTH) {
      this.showToast(`Task too long (max ${CONSTANTS.MAX_TASK_LENGTH} chars)`);
      return;
    }

    try {
      await db.addItem(text);
      input.value = '';
      await this.renderInbox();
      input.focus();
    } catch (err) {
      debugLog('error', 'Error adding task', err);
      this.showToast('Error adding task. Storage may be full.');
    }
  }

  async setItemStatus(id, status) {
    this.invalidateHudCache(); // Data is changing
    const item = await db.getItem(id);

    // Save for undo before making changes
    await this.saveForUndo(id, `Moved to ${status}`);

    if (status === 'done') {
      // Check if item has estimate - prompt for actual time
      if (item.estimate_bucket) {
        this.pendingCompletionId = id;
        document.getElementById('actual-time-modal').classList.remove('hidden');
        return;
      }
    }

    let actionDescription = '';

    if (status === 'tomorrow') {
      await db.setTomorrow(id);
      actionDescription = 'Moved to Tomorrow';
    } else if (status === 'today') {
      await db.setToday(id);
      actionDescription = 'Moved to Today';
    } else if (status === 'waiting') {
      // Open modal for what they're waiting on
      this.pendingWaitingId = id;
      const input = document.getElementById('waiting-input');
      input.value = item.waiting_on || '';
      document.getElementById('waiting-modal').classList.remove('hidden');
      input.focus();
      return; // Modal will handle the rest
    } else if (item.status === status) {
      // Toggle off - return to inbox
      await db.updateItem(id, {
        status: 'inbox',
        isTop3: false,
        top3Order: null,
        scheduled_for_date: null
      });
      actionDescription = 'Moved to Inbox';
    } else {
      const updates = {
        status,
        scheduled_for_date: null
      };
      if (status === 'done' || status !== 'today') {
        updates.isTop3 = false;
        updates.top3Order = null;
      }
      await db.updateItem(id, updates);
      actionDescription = status === 'done' ? 'Marked Done' : `Moved to ${status.charAt(0).toUpperCase() + status.slice(1)}`;
    }

    await this.render();
    await this.updateHUD();

    // Show undo toast
    if (actionDescription) {
      this.showUndoToast(actionDescription);
    }
  }

  // ==================== TOP 3 SUGGESTION ====================

  async suggestTop3() {
    const suggestion = await db.suggestTop3();

    if (suggestion.suggested.length === 0) {
      const todayItems = await db.getTodayItems();
      if (todayItems.length === 0) {
        alert('No tasks in Today. Add some tasks first!');
      } else {
        alert('No rated tasks found. Double-tap tasks to rate them with ACE+LMT scores.');
      }
      return;
    }

    await db.applyTop3Suggestion(suggestion);

    // Show message if applicable
    const msgEl = document.getElementById('suggestion-message');
    if (suggestion.message) {
      msgEl.textContent = suggestion.message;
      msgEl.classList.remove('hidden');
    } else {
      msgEl.classList.add('hidden');
    }

    await this.render();
    await this.updateHUD();
  }

  async rebuildTop3() {
    // Clear current Top 3 first
    const allItems = await db.getAllItems();
    for (const item of allItems) {
      if (item.isTop3) {
        await db.updateItem(item.id, { isTop3: false, top3Order: null });
      }
    }

    // Then suggest new ones
    await this.suggestTop3();
  }

  async autoBalance() {
    const usableCapacity = await db.getUsableCapacity();
    const todayItems = await db.getTodayItems();

    // Score all today items
    const scored = await Promise.all(todayItems.map(async item => {
      const scores = db.calculateScores(item);
      const bufferedMinutes = await db.getBufferedMinutes(item);
      return { ...item, ...scores, bufferedMinutes: bufferedMinutes || 0 };
    }));

    let totalBuffered = scored.reduce((sum, i) => sum + i.bufferedMinutes, 0);

    if (totalBuffered <= usableCapacity) {
      this.showToast('Already within capacity');
      return;
    }

    // Separate Top 3 (keep) from non-Top 3 (candidates to move)
    const top3 = scored.filter(i => i.isTop3);
    const others = scored.filter(i => !i.isTop3);

    // Sort non-Top 3 by priority: lowest first (remove least important first)
    others.sort((a, b) => (a.priority_score || 0) - (b.priority_score || 0));

    let movedCount = 0;

    // Move lowest-priority non-Top 3 items to Tomorrow
    for (const item of others) {
      if (totalBuffered <= usableCapacity) break;

      await db.setTomorrow(item.id);
      totalBuffered -= item.bufferedMinutes;
      movedCount++;
    }

    // If still over capacity after moving all non-Top 3, remove lowest Top 3
    if (totalBuffered > usableCapacity) {
      const top3Sorted = [...top3].sort((a, b) => (a.priority_score || 0) - (b.priority_score || 0));
      for (const item of top3Sorted) {
        if (totalBuffered <= usableCapacity) break;

        await db.setTomorrow(item.id);
        totalBuffered -= item.bufferedMinutes;
        movedCount++;
      }
    }

    this.showToast(`Moved ${movedCount} task${movedCount !== 1 ? 's' : ''} to Tomorrow`);

    await this.render();
    await this.updateHUD();
  }

  // ==================== ACTUAL TIME TRACKING ====================

  async completeWithActualTime(actualBucket) {
    if (!this.pendingCompletionId) return;

    await db.completeTask(this.pendingCompletionId, actualBucket);
    this.pendingCompletionId = null;
    document.getElementById('actual-time-modal').classList.add('hidden');

    await this.render();
    await this.updateHUD();
    this.showUndoToast('Marked Done');
  }

  async skipActualTime() {
    if (!this.pendingCompletionId) return;

    await db.updateItem(this.pendingCompletionId, {
      status: 'done',
      isTop3: false,
      top3Order: null
    });
    this.pendingCompletionId = null;
    document.getElementById('actual-time-modal').classList.add('hidden');

    await this.render();
    await this.updateHUD();
    this.showUndoToast('Marked Done');
  }

  // ==================== KEYBOARD SHORTCUTS ====================

  handleGlobalKeydown(e) {
    // Handle modal focus trap first
    const openModal = document.querySelector('.overlay:not(.hidden)');
    if (openModal) {
      this.handleModalKeydown(e, openModal);
      return;
    }

    // Don't handle shortcuts when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
      return;
    }

    // Only handle shortcuts on certain pages with selected item
    const pagesWithShortcuts = ['inbox', 'today', 'tomorrow', 'next', 'waiting', 'someday', 'done'];
    if (!pagesWithShortcuts.includes(this.currentPage) || !this.selectedItemId) return;

    const key = e.key.toUpperCase();
    const shortcuts = {
      'T': 'today',
      'M': 'tomorrow',
      'N': 'next',
      'W': 'waiting',
      'S': 'someday',
      'D': 'done'
    };

    if (shortcuts[key]) {
      e.preventDefault();
      this.setItemStatus(this.selectedItemId, shortcuts[key]);
    }

    // E for edit
    if (key === 'E') {
      e.preventDefault();
      this.openEditModal(this.selectedItemId);
    }

    // Delete/Backspace to delete (with undo)
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.deleteItemWithUndo(this.selectedItemId);
    }
  }

  async deleteItemWithUndo(itemId) {
    if (!itemId) return;
    this.invalidateHudCache(); // Data is changing

    // Get subtasks before deleting
    const subtasks = await db.getSubtasks(itemId);

    // Save for undo
    await this.saveDeleteForUndo(itemId, 'Deleted', subtasks);

    // Delete subtasks first
    for (const subtask of subtasks) {
      await db.deleteItem(subtask.id);
    }
    // Delete main item
    await db.deleteItem(itemId);

    this.selectedItemId = null;
    await this.render();
    await this.updateHUD();

    // Show undo toast
    this.showUndoToast('Task deleted');
  }

  handleModalKeydown(e, modal) {
    // Close on Escape
    if (e.key === 'Escape') {
      e.preventDefault();
      modal.classList.add('hidden');
      // Reset modal states
      if (modal.id === 'edit-modal') this.editingItemId = null;
      if (modal.id === 'waiting-modal') this.pendingWaitingId = null;
      return;
    }

    // Focus trap on Tab
    if (e.key === 'Tab') {
      const focusableElements = modal.querySelectorAll(
        'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );

      if (focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      // Shift+Tab from first element -> go to last
      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault();
        lastElement.focus();
      }
      // Tab from last element -> go to first
      else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
      }
    }
  }

  // ==================== EDIT MODAL ====================

  async openEditModal(id) {
    this.editingItemId = id;
    const item = await db.getItem(id);

    // Set basic fields
    document.getElementById('edit-text').value = item.text;
    document.getElementById('edit-next-action').value = item.next_action || '';
    document.getElementById('edit-notes').value = item.notes || '';
    document.getElementById('edit-scheduled').value = item.scheduled_for_date || '';
    document.getElementById('edit-due').value = item.dueDate || '';
    document.getElementById('edit-waiting-on').value = item.waiting_on || '';

    // Set recurrence fields
    const recurrenceSelect = document.getElementById('edit-recurrence');
    const recurrenceDaySelect = document.getElementById('edit-recurrence-day');
    recurrenceSelect.value = item.recurrence || '';
    recurrenceDaySelect.value = item.recurrence_day || '0';
    recurrenceDaySelect.classList.toggle('hidden', item.recurrence !== 'weekly');

    // Store edit state
    this.editState = {
      A: item.A,
      C: item.C,
      E: item.E,
      L: item.L,
      M: item.M,
      T: item.T,
      tag: item.tag,
      estimate_bucket: item.estimate_bucket,
      confidence: item.confidence,
      waiting_on: item.waiting_on,
      recurrence: item.recurrence,
      recurrence_day: item.recurrence_day
    };

    // Update all button states
    this.updateEditModalButtons();

    // Load and display subtasks (hide section if this is a subtask itself)
    const subtasksSection = document.getElementById('subtasks-section');
    if (item.parent_id) {
      subtasksSection.classList.add('hidden');
    } else {
      subtasksSection.classList.remove('hidden');
      await this.renderSubtasksList();
    }

    document.getElementById('edit-modal').classList.remove('hidden');
    document.getElementById('edit-text').focus();
  }

  updateEditModalButtons() {
    // Update tag buttons
    document.querySelectorAll('.tag-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tag === this.editState.tag);
    });

    // Update score buttons
    ['A', 'C', 'E', 'L', 'M', 'T'].forEach(field => {
      const container = document.querySelector(`.score-buttons[data-field="${field}"]`);
      if (container) {
        container.querySelectorAll('button').forEach(btn => {
          btn.classList.toggle('active', parseInt(btn.dataset.value) === this.editState[field]);
        });
      }
    });

    // Update bucket buttons
    document.querySelectorAll('.bucket-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.bucket) === this.editState.estimate_bucket);
    });

    // Update confidence buttons
    document.querySelectorAll('.confidence-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.confidence === this.editState.confidence);
    });
  }

  selectTag(tag) {
    this.editState.tag = this.editState.tag === tag ? null : tag;
    this.updateEditModalButtons();
  }

  selectScore(field, value) {
    this.editState[field] = this.editState[field] === value ? null : value;
    this.updateEditModalButtons();
  }

  selectBucket(bucket) {
    this.editState.estimate_bucket = this.editState.estimate_bucket === bucket ? null : bucket;
    this.updateEditModalButtons();
  }

  selectConfidence(confidence) {
    this.editState.confidence = this.editState.confidence === confidence ? null : confidence;
    this.updateEditModalButtons();
  }

  async applyPreset(presetKey) {
    const presets = db.getPresets();
    const preset = presets[presetKey];
    if (!preset) return;

    // Apply preset values to edit state
    if (preset.A !== undefined) this.editState.A = preset.A;
    if (preset.C !== undefined) this.editState.C = preset.C;
    if (preset.E !== undefined) this.editState.E = preset.E;
    if (preset.L !== undefined) this.editState.L = preset.L;
    if (preset.M !== undefined) this.editState.M = preset.M;
    if (preset.T !== undefined) this.editState.T = preset.T;
    if (preset.estimate_bucket !== undefined) this.editState.estimate_bucket = preset.estimate_bucket;
    if (preset.confidence !== undefined) this.editState.confidence = preset.confidence;

    // Focus waiting_on field if this is the waiting preset
    if (preset.status === 'waiting') {
      document.getElementById('edit-waiting-on').focus();
    }

    this.updateEditModalButtons();
  }

  closeEditModal() {
    this.editingItemId = null;
    document.getElementById('edit-modal').classList.add('hidden');
  }

  async saveEditItem() {
    if (!this.editingItemId) return;
    this.invalidateHudCache(); // Data is changing

    const recurrenceValue = document.getElementById('edit-recurrence').value;
    const recurrenceDayValue = document.getElementById('edit-recurrence-day').value;

    // Get and validate text length
    let text = document.getElementById('edit-text').value.trim();
    if (text.length > CONSTANTS.MAX_TASK_LENGTH) {
      text = text.substring(0, CONSTANTS.MAX_TASK_LENGTH);
    }

    // Get and validate notes length
    let notes = document.getElementById('edit-notes').value.trim() || null;
    if (notes && notes.length > CONSTANTS.MAX_NOTES_LENGTH) {
      notes = notes.substring(0, CONSTANTS.MAX_NOTES_LENGTH);
    }

    const updates = {
      text: text,
      next_action: document.getElementById('edit-next-action').value.trim() || null,
      notes: notes,
      scheduled_for_date: document.getElementById('edit-scheduled').value || null,
      dueDate: document.getElementById('edit-due').value || null,
      waiting_on: document.getElementById('edit-waiting-on').value.trim() || null,
      // ACE+LMT scores
      A: this.editState.A,
      C: this.editState.C,
      E: this.editState.E,
      L: this.editState.L,
      M: this.editState.M,
      T: this.editState.T,
      // Tag
      tag: this.editState.tag,
      // Time planning
      estimate_bucket: this.editState.estimate_bucket,
      confidence: this.editState.confidence,
      // Recurrence
      recurrence: recurrenceValue || null,
      recurrence_day: recurrenceValue === 'weekly' ? parseInt(recurrenceDayValue) : null
    };

    await db.updateItem(this.editingItemId, updates);
    this.closeEditModal();
    await this.render();
    await this.updateHUD();
  }

  async deleteEditItem() {
    if (!this.editingItemId) return;
    this.invalidateHudCache(); // Data is changing

    // Get subtasks before deleting (for undo)
    const subtasks = await db.getSubtasks(this.editingItemId);

    // Save for undo before deleting
    await this.saveDeleteForUndo(this.editingItemId, 'Deleted', subtasks);

    // Delete subtasks first
    for (const subtask of subtasks) {
      await db.deleteItem(subtask.id);
    }
    // Delete main item
    await db.deleteItem(this.editingItemId);

    this.closeEditModal();
    this.selectedItemId = null;
    await this.render();
    await this.updateHUD();

    // Show undo toast
    this.showUndoToast('Task deleted');
  }

  // ==================== SUB-TASKS ====================

  async renderSubtasksList() {
    if (!this.editingItemId) return;

    try {
      const subtasks = await db.getSubtasks(this.editingItemId);
      const list = document.getElementById('subtasks-list');

      if (subtasks.length === 0) {
        list.innerHTML = '<li class="subtask-empty">No sub-tasks yet</li>';
        return;
      }

      // Build subtask list without inline handlers
      list.innerHTML = '';
      subtasks.forEach(subtask => {
        const li = document.createElement('li');
        li.className = `subtask-item ${subtask.status === 'done' ? 'done' : ''}`;
        li.dataset.id = subtask.id;

        const label = document.createElement('label');
        label.className = 'subtask-checkbox';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = subtask.status === 'done';
        checkbox.addEventListener('change', () => this.toggleSubtask(subtask.id));

        const textSpan = document.createElement('span');
        textSpan.className = 'subtask-text';
        textSpan.textContent = subtask.text;

        label.appendChild(checkbox);
        label.appendChild(textSpan);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'subtask-delete';
        deleteBtn.innerHTML = '&times;';
        deleteBtn.setAttribute('aria-label', 'Delete subtask');
        deleteBtn.addEventListener('click', () => this.deleteSubtask(subtask.id));

        li.appendChild(label);
        li.appendChild(deleteBtn);
        list.appendChild(li);
      });
    } catch (err) {
      debugLog('error', 'Error rendering subtasks', err);
      this.showToast('Error loading subtasks');
    }
  }

  async addSubtask() {
    if (!this.editingItemId) return;

    const input = document.getElementById('subtask-input');
    const text = input.value.trim();
    if (!text) return;

    // Validate length
    if (text.length > CONSTANTS.MAX_TASK_LENGTH) {
      this.showToast(`Subtask too long (max ${CONSTANTS.MAX_TASK_LENGTH} chars)`);
      return;
    }

    try {
      await db.addSubtask(this.editingItemId, text);
      input.value = '';
      await this.renderSubtasksList();
    } catch (err) {
      debugLog('error', 'Error adding subtask', err);
      this.showToast('Error adding subtask');
    }
  }

  async toggleSubtask(subtaskId) {
    try {
      const subtask = await db.getItem(subtaskId);
      if (!subtask) return;

      // Get parent item to determine proper non-done status
      const parent = await db.getItem(subtask.parent_id);
      const parentStatus = parent ? parent.status : 'today';

      // Toggle between done and parent's status (not hardcoded 'today')
      const newStatus = subtask.status === 'done' ? parentStatus : 'done';
      await db.updateItem(subtaskId, { status: newStatus });
      await this.renderSubtasksList();
      await this.render();
      await this.updateHUD();
    } catch (err) {
      debugLog('error', 'Error toggling subtask', err);
      this.showToast('Error updating subtask');
    }
  }

  async deleteSubtask(subtaskId) {
    try {
      await db.deleteItem(subtaskId);
      await this.renderSubtasksList();
      await this.render();
      await this.updateHUD();
    } catch (err) {
      debugLog('error', 'Error deleting subtask', err);
      this.showToast('Error deleting subtask');
    }
  }

  // ==================== ROUTINES ====================

  async renderRoutines() {
    const routines = await db.getAllRoutines();
    const list = document.getElementById('routines-list');

    if (routines.length === 0) {
      list.innerHTML = '<li class="empty-state"><p>No routines yet.<br>Create one above!</p></li>';
      return;
    }

    list.innerHTML = routines.map(routine => `
      <li class="routine-item" data-id="${routine.id}">
        <div class="routine-header">
          <span class="routine-name">${this.escapeHtml(routine.name)}</span>
          <span class="routine-count">${routine.items.length} items</span>
        </div>
        ${routine.items.length > 0 ? `
          <ul class="routine-checklist">
            ${routine.items.slice(0, 5).map(item => `<li>${this.escapeHtml(item)}</li>`).join('')}
            ${routine.items.length > 5 ? `<li>... and ${routine.items.length - 5} more</li>` : ''}
          </ul>
        ` : ''}
        <div class="routine-actions">
          <button class="btn-primary btn-sm run-routine-btn">Run Routine</button>
          <button class="btn-secondary btn-sm edit-routine-btn">Edit</button>
        </div>
      </li>
    `).join('');

    // Bind routine events
    document.querySelectorAll('.run-routine-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.closest('.routine-item').dataset.id;
        this.runRoutine(id);
      });
    });

    document.querySelectorAll('.edit-routine-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.closest('.routine-item').dataset.id;
        this.openRoutineModal(id);
      });
    });
  }

  async addRoutine() {
    const input = document.getElementById('routine-name-input');
    const name = input.value.trim();
    if (!name) return;

    const routine = await db.addRoutine(name);
    input.value = '';
    this.openRoutineModal(routine.id);
  }

  async openRoutineModal(id) {
    this.editingRoutineId = id;
    const routine = await db.getRoutine(id);

    document.getElementById('routine-modal-title').textContent = routine.name ? 'Edit Routine' : 'New Routine';
    document.getElementById('routine-edit-name').value = routine.name;

    this.renderRoutineItems(routine.items);

    document.getElementById('routine-modal').classList.remove('hidden');
    document.getElementById('routine-edit-name').focus();
  }

  renderRoutineItems(items) {
    const list = document.getElementById('routine-items-list');
    list.innerHTML = items.map((item, index) => `
      <li>
        <span>${this.escapeHtml(item)}</span>
        <button data-index="${index}">&times;</button>
      </li>
    `).join('');

    list.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => this.removeRoutineItem(parseInt(btn.dataset.index)));
    });
  }

  async addRoutineItem() {
    const input = document.getElementById('routine-item-input');
    const text = input.value.trim();
    if (!text || !this.editingRoutineId) return;

    const routine = await db.getRoutine(this.editingRoutineId);
    routine.items.push(text);
    await db.updateRoutine(this.editingRoutineId, { items: routine.items });

    input.value = '';
    this.renderRoutineItems(routine.items);
    input.focus();
  }

  async removeRoutineItem(index) {
    const routine = await db.getRoutine(this.editingRoutineId);
    routine.items.splice(index, 1);
    await db.updateRoutine(this.editingRoutineId, { items: routine.items });
    this.renderRoutineItems(routine.items);
  }

  closeRoutineModal() {
    this.editingRoutineId = null;
    document.getElementById('routine-modal').classList.add('hidden');
  }

  async saveRoutine() {
    if (!this.editingRoutineId) return;

    const name = document.getElementById('routine-edit-name').value.trim();
    if (!name) {
      alert('Please enter a routine name');
      return;
    }

    await db.updateRoutine(this.editingRoutineId, { name });
    this.closeRoutineModal();
    await this.renderRoutines();
  }

  async deleteRoutine() {
    if (!this.editingRoutineId) return;
    if (confirm('Delete this routine?')) {
      await db.deleteRoutine(this.editingRoutineId);
      this.closeRoutineModal();
      await this.renderRoutines();
    }
  }

  async runRoutine(id) {
    const routine = await db.getRoutine(id);
    if (routine.items.length === 0) {
      alert('This routine has no items');
      return;
    }

    await db.runRoutine(id);
    alert(`Added ${routine.items.length} items to Today!`);
    this.navigateTo('today');
  }

  // ==================== ANALYTICS ====================

  async renderAnalytics() {
    const allItems = await db.getAllItems();
    const doneItems = allItems.filter(i => i.status === 'done');

    // Calculate this week's stats
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const thisWeekDone = doneItems.filter(i => {
      const updated = new Date(i.updated_at);
      return updated >= oneWeekAgo;
    });

    document.getElementById('stat-week-completed').textContent = thisWeekDone.length;

    // Calculate total time this week
    const weekTime = thisWeekDone.reduce((sum, i) => {
      return sum + (i.actual_bucket || i.estimate_bucket || 0);
    }, 0);
    const weekHours = (weekTime / 60).toFixed(1);
    document.getElementById('stat-week-time').textContent = `${weekHours}h`;

    // Calculate estimation accuracy
    const itemsWithBoth = doneItems.filter(i => i.estimate_bucket && i.actual_bucket);
    if (itemsWithBoth.length > 0) {
      let totalAccuracy = 0;
      itemsWithBoth.forEach(i => {
        const ratio = Math.min(i.estimate_bucket, i.actual_bucket) / Math.max(i.estimate_bucket, i.actual_bucket);
        totalAccuracy += ratio * 100;
      });
      const avgAccuracy = Math.round(totalAccuracy / itemsWithBoth.length);
      document.getElementById('stat-accuracy').textContent = `${avgAccuracy}%`;

      // Accuracy hint
      const hint = document.getElementById('stat-accuracy-hint');
      if (avgAccuracy >= 80) {
        hint.textContent = 'Great estimating! Keep it up.';
      } else if (avgAccuracy >= 60) {
        hint.textContent = 'Room for improvement. Try breaking down large tasks.';
      } else {
        hint.textContent = 'Consider using more buffer time or smaller estimates.';
      }
    } else {
      document.getElementById('stat-accuracy').textContent = '-';
      document.getElementById('stat-accuracy-hint').textContent = 'Complete tasks with estimates to see accuracy.';
    }
    document.getElementById('stat-estimated-count').textContent = itemsWithBoth.length;

    // All time stats
    document.getElementById('stat-total-completed').textContent = doneItems.length;

    // Calculate weeks since first task
    if (doneItems.length > 0) {
      const firstTask = doneItems.reduce((oldest, item) => {
        const date = new Date(item.created_at);
        return date < oldest ? date : oldest;
      }, new Date());
      const weeksSinceFirst = Math.max(1, Math.ceil((new Date() - firstTask) / (7 * 24 * 60 * 60 * 1000)));
      const avgPerWeek = (doneItems.length / weeksSinceFirst).toFixed(1);
      document.getElementById('stat-avg-per-week').textContent = avgPerWeek;
    } else {
      document.getElementById('stat-avg-per-week').textContent = '0';
    }

    // Stats by tag - build safely without innerHTML XSS
    const tagStats = {};
    doneItems.forEach(item => {
      const tag = item.tag || 'Untagged';
      tagStats[tag] = (tagStats[tag] || 0) + 1;
    });

    const tagContainer = document.getElementById('stat-by-tag');
    tagContainer.innerHTML = '';

    const sortedTags = Object.entries(tagStats).sort((a, b) => b[1] - a[1]);

    if (sortedTags.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'stat-hint';
      hint.textContent = 'No completed tasks yet';
      tagContainer.appendChild(hint);
    } else {
      sortedTags.forEach(([tag, count]) => {
        const div = document.createElement('div');
        div.className = 'tag-stat';

        const tagSpan = document.createElement('span');
        tagSpan.textContent = tag; // Safe - uses textContent

        const countSpan = document.createElement('span');
        countSpan.textContent = count;

        div.appendChild(tagSpan);
        div.appendChild(countSpan);
        tagContainer.appendChild(div);
      });
    }
  }

  // ==================== FOCUS MODE ====================

  async startFocus() {
    const top3Items = await db.getTop3Items();
    if (top3Items.length === 0) {
      const todayItems = await db.getTodayItems();
      if (todayItems.length === 0) {
        alert('No items to focus on. Add items to Today first.');
        return;
      }
    }

    const item = top3Items[0] || (await db.getTodayItems())[0];
    if (!item) return;

    this.selectedItemId = item.id;
    this.focusTimeRemaining = this.timerDefault * 60;
    this.focusPaused = false;

    document.getElementById('focus-task-name').textContent = item.text;
    this.updateFocusTimerDisplay();
    document.getElementById('focus-overlay').classList.remove('hidden');
    document.getElementById('focus-pause-btn').textContent = 'Pause';

    this.focusTimer = setInterval(() => {
      if (!this.focusPaused) {
        this.focusTimeRemaining--;
        this.updateFocusTimerDisplay();

        if (this.focusTimeRemaining <= 0) {
          this.completeFocus();
        }
      }
    }, 1000);
  }

  updateFocusTimerDisplay() {
    const minutes = Math.floor(this.focusTimeRemaining / 60);
    const seconds = this.focusTimeRemaining % 60;
    document.getElementById('focus-timer').textContent =
      `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  toggleFocusPause() {
    this.focusPaused = !this.focusPaused;
    document.getElementById('focus-pause-btn').textContent = this.focusPaused ? 'Resume' : 'Pause';
  }

  stopFocus() {
    if (this.focusTimer) {
      clearInterval(this.focusTimer);
      this.focusTimer = null;
    }
    document.getElementById('focus-overlay').classList.add('hidden');
  }

  async completeFocus() {
    this.stopFocus();

    if (this.selectedItemId) {
      const item = await db.getItem(this.selectedItemId);
      const markDone = confirm('Focus session complete! Mark task as done?');
      if (markDone) {
        if (item.estimate_bucket) {
          this.pendingCompletionId = this.selectedItemId;
          document.getElementById('actual-time-modal').classList.remove('hidden');
        } else {
          await db.updateItem(this.selectedItemId, {
            status: 'done',
            isTop3: false,
            top3Order: null
          });
        }
      }
    }

    this.selectedItemId = null;
    await this.render();
    await this.updateHUD();
  }

  // ==================== SETTINGS ====================

  setTimerPreset(btn) {
    document.querySelectorAll('.timer-preset').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const minutes = parseInt(btn.dataset.minutes);
    const customInput = document.getElementById('custom-timer');

    if (minutes === 0) {
      customInput.hidden = false;
      customInput.focus();
    } else {
      customInput.hidden = true;
      this.timerDefault = minutes;
      db.setSetting('timerDefault', minutes);
    }
  }

  setCustomTimer(e) {
    const minutes = parseInt(e.target.value);
    if (minutes > 0 && minutes <= 180) {
      this.timerDefault = minutes;
      db.setSetting('timerDefault', minutes);
    }
  }

  async exportData() {
    const data = await db.exportData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `battle-plan-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();

    URL.revokeObjectURL(url);
  }

  async importData(e) {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // Validate import structure
      if (!data || typeof data !== 'object') {
        throw new Error('Invalid file format');
      }

      // Validate items array
      const itemCount = data.items ? data.items.length : 0;
      if (itemCount > CONSTANTS.MAX_IMPORT_ITEMS) {
        throw new Error(`Too many items (max ${CONSTANTS.MAX_IMPORT_ITEMS})`);
      }

      // Validate each item has required fields
      if (data.items) {
        for (const item of data.items) {
          if (!item.id || typeof item.text !== 'string') {
            throw new Error('Invalid item structure');
          }
          // Truncate overly long text
          if (item.text.length > CONSTANTS.MAX_TASK_LENGTH) {
            item.text = item.text.substring(0, CONSTANTS.MAX_TASK_LENGTH);
          }
          // Validate status
          if (item.status && !CONSTANTS.VALID_STATUSES.includes(item.status)) {
            item.status = 'inbox';
          }
        }
      }

      // Store pending data and show confirmation modal
      this.pendingImportData = data;

      // Show info about what will be imported
      const routineCount = data.routines ? data.routines.length : 0;
      const version = data.version || 'unknown';

      document.getElementById('import-file-info').textContent =
        `File: ${file.name}\nVersion: ${version}\nItems: ${itemCount}, Routines: ${routineCount}`;
      document.getElementById('import-confirm-modal').classList.remove('hidden');
    } catch (err) {
      debugLog('error', 'File read error', err);
      alert('Unable to read file. Please check the file format and try again.');
    }

    e.target.value = '';
  }

  async confirmImport() {
    if (!this.pendingImportData) return;

    try {
      await db.importData(this.pendingImportData);
      this.pendingImportData = null;
      document.getElementById('import-confirm-modal').classList.add('hidden');
      alert('Data imported successfully!');
      await this.render();
      await this.updateHUD();
    } catch (err) {
      debugLog('error', 'Import error', err);
      alert('Unable to import data. The file may be corrupted or incompatible.');
    }
  }

  cancelImport() {
    this.pendingImportData = null;
    document.getElementById('import-confirm-modal').classList.add('hidden');
  }

  async confirmWaiting() {
    if (!this.pendingWaitingId) return;

    const waitingOn = document.getElementById('waiting-input').value.trim();
    const updates = {
      status: 'waiting',
      waiting_on: waitingOn || null,
      scheduled_for_date: null,
      isTop3: false,
      top3Order: null
    };

    await db.updateItem(this.pendingWaitingId, updates);
    document.getElementById('waiting-modal').classList.add('hidden');
    this.pendingWaitingId = null;

    await this.render();
    await this.updateHUD();
    this.showUndoToast('Moved to Waiting');
  }

  cancelWaiting() {
    this.pendingWaitingId = null;
    document.getElementById('waiting-modal').classList.add('hidden');
  }

  // ==================== OVERDUE MANAGEMENT ====================

  async showOverdueModal() {
    const allItems = await db.getAllItems();
    const overdueItems = allItems.filter(item => db.isOverdue(item) && item.status !== 'done');

    const list = document.getElementById('overdue-list');
    if (overdueItems.length === 0) {
      list.innerHTML = '<li>No overdue tasks!</li>';
    } else {
      list.innerHTML = overdueItems.map(item => `
        <li data-id="${item.id}">
          <div class="task-info">
            <span class="task-text">${this.escapeHtml(item.text)}</span>
            <span class="task-date">Scheduled: ${item.scheduled_for_date}</span>
          </div>
          <div class="task-actions">
            <button class="btn-today" data-action="today">Today</button>
            <button class="btn-done" data-action="done">Done</button>
          </div>
        </li>
      `).join('');

      // Bind action buttons
      list.querySelectorAll('.task-actions button').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const li = e.target.closest('li');
          const itemId = li.dataset.id;
          const action = e.target.dataset.action;

          this.invalidateHudCache();
          if (action === 'today') {
            await db.setToday(itemId);
          } else if (action === 'done') {
            await db.updateItem(itemId, { status: 'done', isTop3: false, top3Order: null });
          }

          // Remove from list
          li.remove();

          // Check if list is empty
          if (list.children.length === 0) {
            list.innerHTML = '<li>All overdue tasks handled!</li>';
          }

          await this.render();
          await this.updateHUD();
        });
      });
    }

    document.getElementById('overdue-modal').classList.remove('hidden');
  }

  async rescheduleAllOverdue() {
    const allItems = await db.getAllItems();
    const overdueItems = allItems.filter(item => db.isOverdue(item) && item.status !== 'done');

    this.invalidateHudCache();

    for (const item of overdueItems) {
      await db.setToday(item.id);
    }

    this.closeOverdueModal();
    this.showToast(`Moved ${overdueItems.length} task${overdueItems.length !== 1 ? 's' : ''} to Today`);
    await this.render();
    await this.updateHUD();
  }

  closeOverdueModal() {
    document.getElementById('overdue-modal').classList.add('hidden');
  }

  // ==================== SORTING ====================

  /**
   * Tiered sorting: groups by urgency tier, then sorts by priority_score within each tier.
   * Tiers (in order):
   *   0: Overdue scheduled tasks (scheduled_for_date < today)
   *   1: Due today or past due (dueDate <= today)
   *   2: Due tomorrow
   *   3: Due within 3 days
   *   4: Everything else
   * Within each tier: sort by priority_score descending, then by newest first.
   */
  sortByPriority(items) {
    const today = new Date().toISOString().split('T')[0];
    const todayDate = new Date(today);

    // Get tomorrow's date string
    const tomorrowDate = new Date(todayDate);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrow = tomorrowDate.toISOString().split('T')[0];

    // Get 3 days from now
    const threeDaysDate = new Date(todayDate);
    threeDaysDate.setDate(threeDaysDate.getDate() + 3);
    const threeDays = threeDaysDate.toISOString().split('T')[0];

    return items.sort((a, b) => {
      // Determine tier for each item
      const tierA = this.getUrgencyTier(a, today, tomorrow, threeDays);
      const tierB = this.getUrgencyTier(b, today, tomorrow, threeDays);

      // Lower tier number = higher priority (sort ascending by tier)
      if (tierA !== tierB) return tierA - tierB;

      // Within same tier: sort by priority_score descending
      const scoreA = this.getPriorityScore(a);
      const scoreB = this.getPriorityScore(b);
      if (scoreB !== scoreA) return scoreB - scoreA;

      // Tie-breaker: newer items first
      const createdA = new Date(a.created_at || a.created || 0);
      const createdB = new Date(b.created_at || b.created || 0);
      return createdB - createdA;
    });
  }

  /**
   * Returns urgency tier for an item:
   *   0: Overdue scheduled tasks
   *   1: Due today or past due
   *   2: Due tomorrow
   *   3: Due within 3 days
   *   4: Everything else
   */
  getUrgencyTier(item, today, tomorrow, threeDays) {
    // Tier 0: Overdue scheduled tasks (scheduled but past)
    if (item.scheduled_for_date && item.scheduled_for_date < today && item.status !== 'done') {
      return 0;
    }

    // Check due date for tiers 1-3
    if (item.dueDate) {
      if (item.dueDate <= today) {
        return 1; // Tier 1: Due today or past due
      }
      if (item.dueDate <= tomorrow) {
        return 2; // Tier 2: Due tomorrow
      }
      if (item.dueDate <= threeDays) {
        return 3; // Tier 3: Due within 3 days
      }
    }

    // Tier 4: Everything else
    return 4;
  }

  /**
   * Get priority score for an item (with caching for sort performance).
   * Adds bonuses for URGENT (C=5) and rated items.
   */
  getPriorityScore(item) {
    // Check cache (invalidate after 5 seconds)
    const now = Date.now();
    if (now - this.scoreCacheTime > 5000) {
      this.scoreCache.clear();
      this.scoreCacheTime = now;
    }

    // Return cached score if available
    if (this.scoreCache.has(item.id)) {
      return this.scoreCache.get(item.id);
    }

    let score = 0;

    // Base ACE+LMT score (0-27 range)
    const scores = db.calculateScores(item);
    if (scores.priority_score !== null) {
      score = scores.priority_score;
    }

    // URGENT (C=5) gets extra visibility even without full rating
    if (item.C === 5) {
      score += 10;
    }

    // Rated items get slight preference over unrated within same tier
    if (db.isRated(item)) {
      score += 1;
    }

    // Cache the score
    this.scoreCache.set(item.id, score);
    return score;
  }

  /**
   * Clear score cache (call after updates)
   */
  invalidateScoreCache() {
    this.scoreCache.clear();
  }

  // ==================== UTILITIES ====================

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Validate and sanitize text input
   */
  sanitizeText(text, maxLength = CONSTANTS.MAX_TASK_LENGTH) {
    if (!text || typeof text !== 'string') return '';
    return text.trim().substring(0, maxLength);
  }

  /**
   * Highlight search query in text (safe - escapes HTML first)
   */
  highlightSearch(text) {
    if (!this.searchQuery.trim()) {
      return this.escapeHtml(text);
    }

    const escaped = this.escapeHtml(text);
    const query = this.searchQuery.trim();
    const escapedQuery = this.escapeHtml(query);

    // Case-insensitive replace with mark tag
    const regex = new RegExp(`(${escapedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return escaped.replace(regex, '<mark>$1</mark>');
  }
}

// Initialize app
const app = new BattlePlanApp();

// Initialize AI Voice Assistant (loads after app)
if (window.VoiceAssistant) {
  app.voiceAssistant = new VoiceAssistant(app);
}
