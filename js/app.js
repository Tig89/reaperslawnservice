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

    this.init();
  }

  async init() {
    await db.ready;

    // Run rollover on app load
    await db.runRollover();

    // Load settings
    this.timerDefault = await db.getSetting('timerDefault', 25);

    this.bindEvents();
    this.render();
    this.updateHUD();
  }

  // ==================== EVENT BINDING ====================

  bindEvents() {
    // Navigation
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => this.navigateTo(btn.dataset.page));
    });

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
    const weekday = await db.getSetting('weekday_capacity_minutes', 180);
    const weekend = await db.getSetting('weekend_capacity_minutes', 360);
    const slack = await db.getSetting('always_plan_slack_percent', 30);

    document.getElementById('setting-weekday-capacity').value = weekday;
    document.getElementById('setting-weekend-capacity').value = weekend;
    document.getElementById('setting-slack').value = slack;
  }

  // ==================== NAVIGATION ====================

  navigateTo(page) {
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

    this.render();
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

    if (item.confidence) {
      metaHtml += `<span class="item-confidence ${item.confidence}">${item.confidence}</span>`;
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

    // Action buttons for Today view (Top 3 toggle + Done button)
    let actionsHtml = '';
    if (showTop3Toggle || isTop3) {
      const top3BtnClass = (item.isTop3 || isTop3) ? 'in-top3' : '';
      const top3BtnText = (item.isTop3 || isTop3) ? '- Top 3' : '+ Top 3';
      actionsHtml = `
        <div class="item-actions">
          <button class="done-btn">Done</button>
          <button class="top3-toggle ${top3BtnClass}">${top3BtnText}</button>
        </div>
      `;
    }

    return `
      <li class="item ${statusClass} ${selectedClass} ${overdueClass}" data-id="${item.id}">
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
        if (e.target.classList.contains('pill') || e.target.classList.contains('top3-toggle')) return;
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
      await db.importData(data);
      alert('Data imported successfully!');
      await this.render();
      await this.updateHUD();
    } catch (err) {
      alert('Error importing data: ' + err.message);
    }

    e.target.value = '';
  }

  // ==================== SORTING ====================

  sortByPriority(items) {
    const today = new Date().toISOString().split('T')[0];

    return items.sort((a, b) => {
      // Calculate effective priority for each item
      const scoreA = this.calculateEffectivePriority(a, today);
      const scoreB = this.calculateEffectivePriority(b, today);

      // Higher score = higher priority (sort descending)
      if (scoreB !== scoreA) return scoreB - scoreA;

      // Tie-breaker: newer items first
      return new Date(b.created_at) - new Date(a.created_at);
    });
  }

  calculateEffectivePriority(item, today) {
    let score = 0;

    // Base ACE+LMT score (0-27 range)
    const scores = db.calculateScores(item);
    if (scores.priority_score !== null) {
      score = scores.priority_score;
    }

    // Time sensitivity bonuses
    const isOverdue = item.scheduled_for_date && item.scheduled_for_date < today && item.status !== 'done';
    const hasDueDate = item.dueDate;

    // Overdue items get big boost (+20)
    if (isOverdue) {
      score += 20;
    }

    // Due date approaching (within 3 days) gets boost
    if (hasDueDate) {
      const dueDate = new Date(item.dueDate);
      const todayDate = new Date(today);
      const daysUntilDue = Math.ceil((dueDate - todayDate) / (1000 * 60 * 60 * 24));

      if (daysUntilDue <= 0) {
        score += 15; // Due today or past due
      } else if (daysUntilDue <= 1) {
        score += 10; // Due tomorrow
      } else if (daysUntilDue <= 3) {
        score += 5; // Due within 3 days
      }
    }

    // URGENT (C=5) gets extra visibility even without full rating
    if (item.C === 5) {
      score += 10;
    }

    // Rated items get slight preference over unrated
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
