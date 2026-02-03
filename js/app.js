/**
 * Battle Plan - Main Application
 * Army-style task prioritization with ACE+LMT scoring
 */

class BattlePlanApp {
  constructor() {
    this.currentPage = 'inbox';
    this.selectedItemId = null;
    this.editingItemId = null;
    this.editingRoutineId = null;
    this.focusTimer = null;
    this.focusTimeRemaining = 0;
    this.focusPaused = false;
    this.timerDefault = 25;
    this.searchQuery = '';
    this.searchAll = false;

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

    // Swipe gesture state
    this.swipeState = null;
    this.swipeEnabled = true;

    // Voice input state
    this.speechRecognition = null;
    this.isListening = false;
    this.voiceSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

    this.init();
  }

  async init() {
    await db.ready;

    // Run rollover on app load
    await db.runRollover();

    // Load settings
    this.timerDefault = await db.getSetting('timerDefault', 25);
    this.swipeEnabled = await db.getSetting('enable_swipe_gestures', true);

    // Initialize voice input if supported
    this.initVoiceInput();

    this.bindEvents();

    // Handle initial page from URL hash (for back button support)
    const hash = window.location.hash.slice(1);
    const validPages = ['inbox', 'today', 'tomorrow', 'next', 'waiting', 'someday', 'done', 'routines', 'settings'];
    if (hash && validPages.includes(hash)) {
      this.navigateTo(hash, false);
    }
    // Set initial history state
    history.replaceState({ page: this.currentPage }, '', `#${this.currentPage}`);

    this.render();
    this.updateHUD();
  }

  // ==================== EVENT BINDING ====================

  bindEvents() {
    // Navigation
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => this.navigateTo(btn.dataset.page));
    });

    // Handle browser back/forward buttons (Android back button support)
    window.addEventListener('popstate', (e) => this.handlePopState(e));

    // Search
    document.getElementById('search-input').addEventListener('input', (e) => {
      this.searchQuery = e.target.value;
      this.render();
    });

    document.getElementById('search-all-checkbox').addEventListener('change', (e) => {
      this.searchAll = e.target.checked;
      this.render();
    });

    // Inbox
    document.getElementById('inbox-input').addEventListener('keydown', (e) => this.handleInboxKeydown(e));
    document.getElementById('inbox-add-btn').addEventListener('click', () => this.addInboxItem());

    // Today actions
    document.getElementById('start-focus-btn').addEventListener('click', () => this.startFocus());
    document.getElementById('suggest-top3-btn').addEventListener('click', () => this.suggestTop3());
    document.getElementById('rebuild-top3-btn').addEventListener('click', () => this.rebuildTop3());
    document.getElementById('auto-balance-btn').addEventListener('click', () => this.autoBalance());

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
    document.getElementById('setting-auto-roll').addEventListener('change', (e) => {
      db.setSetting('auto_roll_tomorrow_to_today', e.target.checked);
    });
    document.getElementById('setting-top3-clear').addEventListener('change', (e) => {
      db.setSetting('top3_auto_clear_daily', e.target.checked);
    });
    document.getElementById('setting-swipe-gestures').addEventListener('change', (e) => {
      this.swipeEnabled = e.target.checked;
      db.setSetting('enable_swipe_gestures', e.target.checked);
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
    const autoRoll = await db.getSetting('auto_roll_tomorrow_to_today', true);
    const top3Clear = await db.getSetting('top3_auto_clear_daily', true);
    const swipeEnabled = await db.getSetting('enable_swipe_gestures', true);

    document.getElementById('setting-auto-roll').checked = autoRoll;
    document.getElementById('setting-top3-clear').checked = top3Clear;
    document.getElementById('setting-swipe-gestures').checked = swipeEnabled;
  }

  // ==================== NAVIGATION ====================

  navigateTo(page, pushHistory = true) {
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

  async updateHUD() {
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

    document.getElementById('hud-buffered').textContent = totalBuffered;
    document.getElementById('hud-capacity').textContent = usableCapacity;
    document.getElementById('hud-top3-count').textContent = stats.top3Count;
    document.getElementById('hud-monster-count').textContent = monsterCount;
    document.getElementById('hud-rated').textContent = ratedCount;
    document.getElementById('hud-unrated').textContent = unratedCount;

    // Monster visibility
    const monsterEl = document.getElementById('hud-monster');
    if (monsterCount > 0) {
      monsterEl.style.color = 'var(--monster)';
    } else {
      monsterEl.style.color = '';
    }

    // Overdue
    const overdueEl = document.getElementById('hud-overdue');
    const overdueCountEl = document.getElementById('hud-overdue-count');

    if (stats.overdueCount > 0) {
      overdueEl.classList.remove('hidden');
      overdueCountEl.textContent = stats.overdueCount;
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
    }
  }

  async getFilteredItems(items) {
    if (!this.searchQuery.trim()) return items;

    const query = this.searchQuery.toLowerCase().trim();

    if (this.searchAll) {
      // Search across all items
      const allItems = await db.getAllItems();
      return allItems.filter(item =>
        item.text.toLowerCase().includes(query) ||
        (item.next_action && item.next_action.toLowerCase().includes(query))
      );
    }

    // Search within current view items
    return items.filter(item =>
      item.text.toLowerCase().includes(query) ||
      (item.next_action && item.next_action.toLowerCase().includes(query))
    );
  }

  async renderInbox() {
    let items = await db.getInboxItems();
    items = await this.getFilteredItems(items);

    const list = document.getElementById('inbox-list');

    // Sort by priority (rated items first, then by score, then newest)
    const sorted = this.sortByPriority(items);

    if (sorted.length === 0) {
      const msg = this.searchQuery ? 'No matching items' : 'Inbox is empty. Add something above!';
      list.innerHTML = `<li class="empty-state"><p>${msg}</p></li>`;
      return;
    }

    list.innerHTML = sorted.map(item => this.renderItem(item, { showPills: true })).join('');
    this.bindItemEvents();
  }

  async renderToday() {
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
      top3List.innerHTML = '<li class="empty-state"><p>Tap "Suggest Top 3" to auto-select priorities</p></li>';
    } else {
      const top3Html = await Promise.all(top3Items.map(async (item, index) =>
        await this.renderItemAsync(item, { isTop3: true, top3Number: index + 1 })
      ));
      top3List.innerHTML = top3Html.join('');
    }

    // Other today items
    const todayList = document.getElementById('today-list');
    if (otherItems.length === 0) {
      const msg = this.searchQuery ? 'No matching items' : 'Mark items as Today in Inbox';
      todayList.innerHTML = `<li class="empty-state"><p>${msg}</p></li>`;
    } else {
      const otherHtml = await Promise.all(otherItems.map(async item =>
        await this.renderItemAsync(item, { showTop3Toggle: true })
      ));
      todayList.innerHTML = otherHtml.join('');
    }

    this.bindItemEvents();
  }

  async renderTomorrow() {
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
  }

  async renderByStatus(status) {
    let items = await db.getItemsByStatus(status);
    items = await this.getFilteredItems(items);

    const list = document.getElementById(`${status}-list`);

    if (items.length === 0) {
      const msg = this.searchQuery ? 'No matching items' : `No ${status} items`;
      list.innerHTML = `<li class="empty-state"><p>${msg}</p></li>`;
      return;
    }

    // Sort by priority score + time sensitivity
    const sorted = this.sortByPriority(items);
    list.innerHTML = sorted.map(item => this.renderItem(item, { showPills: true })).join('');
    this.bindItemEvents();
  }

  renderItem(item, options = {}) {
    const { showPills = false, isTop3 = false, top3Number = null, showTop3Toggle = false } = options;

    const statusClass = `status-${item.status}`;
    const selectedClass = item.id === this.selectedItemId ? 'selected' : '';
    const isOverdue = db.isOverdue(item);
    const overdueClass = isOverdue ? 'overdue' : '';

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

    if (dateStr) {
      metaHtml += `<span class="item-date">${dateStr}</span>`;
    }

    if (item.scheduled_for_date) {
      metaHtml += `<span class="item-scheduled">Scheduled: ${item.scheduled_for_date}</span>`;
    }
    if (item.dueDate) {
      metaHtml += `<span class="due-date">Due: ${item.dueDate}</span>`;
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
        <div class="item ${statusClass} ${selectedClass} ${overdueClass}" data-id="${item.id}">
          ${top3Number ? `<span class="top3-badge">${top3Number}</span>` : ''}
          <div class="item-header">
            <div class="item-text">${this.escapeHtml(item.text)}</div>
            ${isOverdue ? '<span class="badge badge-overdue">Overdue</span>' : ''}
          </div>
          ${nextActionHtml}
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
    // Same as renderItem but can add async features like buffered time
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
      if (swipePercent >= 0.6) {
        item.classList.add('swipe-threshold');
      } else {
        item.classList.remove('swipe-threshold');
      }
    } else if (dx < 0) {
      // Swiping left
      leftTray.classList.add('visible');
      rightTray.classList.remove('visible');

      if (swipePercent >= 0.6) {
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
    if (swipePercent >= 0.6) {
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
        // Full swipe left = Tomorrow
        this.animateSwipeOut(wrapper, 'left').then(async () => {
          await db.setTomorrow(itemId);
          await this.render();
          await this.updateHUD();
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
    const closeHandler = (e) => {
      // Check if click is outside the wrapper
      if (!wrapper.contains(e.target)) {
        this.resetSwipe(wrapper);
        document.removeEventListener('click', closeHandler);
        document.removeEventListener('touchstart', closeHandler);
      }
    };

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
        await db.setTomorrow(itemId);
        await this.render();
        await this.updateHUD();
        break;
      case 'edit':
        this.openEditModal(itemId);
        break;
    }
  }

  // ==================== VOICE INPUT ====================

  initVoiceInput() {
    if (!this.voiceSupported) {
      // Hide mic buttons if not supported
      document.querySelectorAll('.voice-btn').forEach(btn => {
        btn.style.display = 'none';
      });
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
      console.error('Speech recognition error:', event.error);
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
  }

  startVoiceInput(targetInputId) {
    if (!this.voiceSupported || !this.speechRecognition) {
      this.showToast('Voice input not supported in this browser');
      return;
    }

    if (this.isListening) {
      this.stopVoiceInput();
      return;
    }

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
      console.error('Failed to start speech recognition:', err);
      this.stopVoiceInput();
      this.showToast('Failed to start voice input');
    }
  }

  stopVoiceInput() {
    this.isListening = false;

    // Update all voice buttons
    document.querySelectorAll('.voice-btn').forEach(btn => {
      btn.classList.remove('listening');
    });

    // Hide listening toast
    this.hideToast();

    try {
      this.speechRecognition?.stop();
    } catch (err) {
      // Ignore errors when stopping
    }
  }

  handleVoiceResult(transcript) {
    const trimmed = transcript.trim();

    // Try to parse as command first
    const command = this.parseVoiceCommand(trimmed);

    if (command) {
      this.executeVoiceCommand(command);
    } else {
      // Insert as text into target input
      const input = document.getElementById(this.currentVoiceTarget);
      if (input) {
        // Append to existing text or replace
        if (input.value.trim()) {
          input.value = input.value.trim() + ' ' + trimmed;
        } else {
          input.value = trimmed;
        }
        input.focus();
        this.showToast('Added: ' + trimmed.substring(0, 30) + (trimmed.length > 30 ? '...' : ''));
      }
    }

    this.stopVoiceInput();
  }

  parseVoiceCommand(text) {
    const lower = text.toLowerCase();

    // "add task <text>"
    if (lower.startsWith('add task ')) {
      return { action: 'add', text: text.substring(9).trim() };
    }

    // "mark done <keyword>" or "complete <keyword>"
    const doneMatch = lower.match(/^(mark done|complete|finish)\s+(.+)$/);
    if (doneMatch) {
      return { action: 'done', keyword: doneMatch[2].trim() };
    }

    // "move <keyword> to tomorrow"
    const tomorrowMatch = lower.match(/^move\s+(.+)\s+to tomorrow$/);
    if (tomorrowMatch) {
      return { action: 'tomorrow', keyword: tomorrowMatch[1].trim() };
    }

    // "start focus"
    if (lower === 'start focus' || lower === 'focus mode') {
      return { action: 'focus' };
    }

    // No command matched - treat as text
    return null;
  }

  async executeVoiceCommand(command) {
    switch (command.action) {
      case 'add':
        await db.addItem(command.text);
        await this.render();
        this.showToast('Added: ' + command.text.substring(0, 20) + '...');
        break;

      case 'done':
        const doneItem = await this.findItemByKeyword(command.keyword);
        if (doneItem) {
          await this.setItemStatus(doneItem.id, 'done');
          this.showToast('Marked done: ' + doneItem.text.substring(0, 20) + '...');
        } else {
          this.showToast('No matching task found');
        }
        break;

      case 'tomorrow':
        const tmrwItem = await this.findItemByKeyword(command.keyword);
        if (tmrwItem) {
          await db.setTomorrow(tmrwItem.id);
          await this.render();
          await this.updateHUD();
          this.showToast('Moved to tomorrow: ' + tmrwItem.text.substring(0, 20) + '...');
        } else {
          this.showToast('No matching task found');
        }
        break;

      case 'focus':
        this.startFocus();
        break;
    }
  }

  async findItemByKeyword(keyword) {
    // Search in current view first
    let items;
    if (this.currentPage === 'today') {
      items = await db.getTodayItems();
    } else if (this.currentPage === 'inbox') {
      items = await db.getInboxItems();
    } else {
      items = await db.getAllItems();
    }

    const lower = keyword.toLowerCase();
    return items.find(item =>
      item.text.toLowerCase().includes(lower) ||
      (item.next_action && item.next_action.toLowerCase().includes(lower))
    );
  }

  showToast(message, type = 'info') {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.className = `toast toast-${type} visible`;

    // Auto-hide after 3 seconds (unless it's listening)
    if (type !== 'listening') {
      setTimeout(() => this.hideToast(), 3000);
    }
  }

  hideToast() {
    const toast = document.getElementById('toast');
    if (toast) {
      toast.classList.remove('visible');
    }
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

    await db.addItem(text);
    input.value = '';
    await this.renderInbox();
    input.focus();
  }

  async setItemStatus(id, status) {
    const item = await db.getItem(id);

    if (status === 'done') {
      // Check if item has estimate - prompt for actual time
      if (item.estimate_bucket) {
        this.pendingCompletionId = id;
        document.getElementById('actual-time-modal').classList.remove('hidden');
        return;
      }
    }

    if (status === 'tomorrow') {
      await db.setTomorrow(id);
    } else if (status === 'today') {
      await db.setToday(id);
    } else if (item.status === status) {
      // Toggle off - return to inbox
      await db.updateItem(id, {
        status: 'inbox',
        isTop3: false,
        top3Order: null,
        scheduled_for_date: null
      });
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
    }

    await this.render();
    await this.updateHUD();
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
    // Remove lowest priority items from Top 3 until under capacity
    const usableCapacity = await db.getUsableCapacity();
    let top3Items = await db.getTop3Items();

    // Calculate scores and sort by priority (lowest first for removal)
    const scored = await Promise.all(top3Items.map(async item => {
      const scores = db.calculateScores(item);
      const bufferedMinutes = await db.getBufferedMinutes(item);
      return { ...item, ...scores, bufferedMinutes };
    }));

    scored.sort((a, b) => (a.priority_score || 0) - (b.priority_score || 0));

    let totalBuffered = scored.reduce((sum, i) => sum + (i.bufferedMinutes || 0), 0);

    // Remove lowest priority items until under capacity
    for (const item of scored) {
      if (totalBuffered <= usableCapacity) break;

      await db.updateItem(item.id, { isTop3: false, top3Order: null });
      totalBuffered -= item.bufferedMinutes || 0;
    }

    // Hide warning
    document.getElementById('capacity-warning').classList.add('hidden');

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
  }

  // ==================== KEYBOARD SHORTCUTS ====================

  handleGlobalKeydown(e) {
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

    // Delete/Backspace to delete
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (confirm('Delete this item?')) {
        db.deleteItem(this.selectedItemId).then(() => {
          this.selectedItemId = null;
          this.render();
          this.updateHUD();
        });
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
    document.getElementById('edit-scheduled').value = item.scheduled_for_date || '';
    document.getElementById('edit-due').value = item.dueDate || '';

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
      confidence: item.confidence
    };

    // Update all button states
    this.updateEditModalButtons();

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

    this.updateEditModalButtons();
  }

  closeEditModal() {
    this.editingItemId = null;
    document.getElementById('edit-modal').classList.add('hidden');
  }

  async saveEditItem() {
    if (!this.editingItemId) return;

    const updates = {
      text: document.getElementById('edit-text').value.trim(),
      next_action: document.getElementById('edit-next-action').value.trim() || null,
      scheduled_for_date: document.getElementById('edit-scheduled').value || null,
      dueDate: document.getElementById('edit-due').value || null,
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
      confidence: this.editState.confidence
    };

    await db.updateItem(this.editingItemId, updates);
    this.closeEditModal();
    await this.render();
    await this.updateHUD();
  }

  async deleteEditItem() {
    if (!this.editingItemId) return;
    if (confirm('Delete this item?')) {
      await db.deleteItem(this.editingItemId);
      this.closeEditModal();
      this.selectedItemId = null;
      await this.render();
      await this.updateHUD();
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

      // Store pending data and show confirmation modal
      this.pendingImportData = data;

      // Show info about what will be imported
      const itemCount = data.items ? data.items.length : 0;
      const routineCount = data.routines ? data.routines.length : 0;
      const version = data.version || 'unknown';

      document.getElementById('import-file-info').textContent =
        `File: ${file.name}\nVersion: ${version}\nItems: ${itemCount}, Routines: ${routineCount}`;
      document.getElementById('import-confirm-modal').classList.remove('hidden');
    } catch (err) {
      alert('Error reading file: ' + err.message);
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
      alert('Error importing data: ' + err.message);
    }
  }

  cancelImport() {
    this.pendingImportData = null;
    document.getElementById('import-confirm-modal').classList.add('hidden');
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
   * Get priority score for an item.
   * Adds bonuses for URGENT (C=5) and rated items.
   */
  getPriorityScore(item) {
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

    return score;
  }

  // ==================== UTILITIES ====================

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize app
const app = new BattlePlanApp();
