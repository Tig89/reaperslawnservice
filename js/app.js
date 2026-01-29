/**
 * Battle Plan - Main Application
 * Simple daily life organizer PWA
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

    this.init();
  }

  async init() {
    await db.ready;
    this.timerDefault = await db.getSetting('timerDefault', 25);
    this.bindEvents();
    this.render();
  }

  // ==================== EVENT BINDING ====================

  bindEvents() {
    // Navigation
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => this.navigateTo(btn.dataset.page));
    });

    // Inbox
    document.getElementById('inbox-input').addEventListener('keydown', (e) => this.handleInboxKeydown(e));
    document.getElementById('inbox-add-btn').addEventListener('click', () => this.addInboxItem());

    // Today
    document.getElementById('start-focus-btn').addEventListener('click', () => this.startFocus());

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

    // Edit Modal
    document.getElementById('edit-save-btn').addEventListener('click', () => this.saveEditItem());
    document.getElementById('edit-delete-btn').addEventListener('click', () => this.deleteEditItem());
    document.getElementById('edit-cancel-btn').addEventListener('click', () => this.closeEditModal());

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

    this.render();
  }

  // ==================== RENDERING ====================

  async render() {
    switch (this.currentPage) {
      case 'inbox':
        await this.renderInbox();
        break;
      case 'today':
        await this.renderToday();
        break;
      case 'routines':
        await this.renderRoutines();
        break;
    }
  }

  async renderInbox() {
    const items = await db.getAllItems();
    const list = document.getElementById('inbox-list');

    // Sort newest first
    const sorted = items.sort((a, b) => new Date(b.created) - new Date(a.created));

    if (sorted.length === 0) {
      list.innerHTML = '<li class="empty-state"><p>No items yet.<br>Add something above!</p></li>';
      return;
    }

    list.innerHTML = sorted.map(item => this.renderItem(item)).join('');
    this.bindItemEvents();
  }

  async renderToday() {
    const items = await db.getAllItems();
    const todayItems = items.filter(i => i.status === 'today');
    const top3Items = items.filter(i => i.isTop3 && i.status !== 'done')
      .sort((a, b) => (a.top3Order || 0) - (b.top3Order || 0));
    const otherItems = todayItems.filter(i => !i.isTop3);

    // Stats
    const totalMinutes = todayItems.reduce((sum, i) => sum + (i.estimate || 0), 0);
    const top3Minutes = top3Items.reduce((sum, i) => sum + (i.estimate || 0), 0);

    document.getElementById('today-total').textContent = `${totalMinutes} min total`;
    document.getElementById('top3-total').textContent = `${top3Minutes} min Top 3`;
    document.getElementById('top3-count').textContent = `(${top3Items.length}/3)`;

    // Top 3 list
    const top3List = document.getElementById('top3-list');
    if (top3Items.length === 0) {
      top3List.innerHTML = '<li class="empty-state"><p>Lock your Top 3 priorities</p></li>';
    } else {
      top3List.innerHTML = top3Items.map((item, index) => this.renderItem(item, true, index + 1)).join('');
    }

    // Other today items
    const todayList = document.getElementById('today-list');
    if (otherItems.length === 0) {
      todayList.innerHTML = '<li class="empty-state"><p>Mark items as Today in Inbox</p></li>';
    } else {
      todayList.innerHTML = otherItems.map(item => this.renderItem(item, false, null, true)).join('');
    }

    this.bindItemEvents();
  }

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

  renderItem(item, isTop3 = false, top3Number = null, showTop3Toggle = false) {
    const statusClass = `status-${item.status}`;
    const selectedClass = item.id === this.selectedItemId ? 'selected' : '';
    const dateStr = new Date(item.created).toLocaleDateString();

    return `
      <li class="item ${statusClass} ${selectedClass}" data-id="${item.id}">
        ${top3Number ? `<span class="top3-badge">${top3Number}</span>` : ''}
        <div class="item-text">${this.escapeHtml(item.text)}</div>
        <div class="item-meta">
          <span class="item-date">${dateStr}</span>
          ${item.estimate ? `<span class="item-estimate">${item.estimate} min</span>` : ''}
          ${item.tag ? `<span class="tag tag-${item.tag}">${item.tag}</span>` : ''}
          ${item.dueDate ? `<span class="due-date">Due: ${item.dueDate}</span>` : ''}
        </div>
        <div class="status-pills">
          <button class="pill pill-today ${item.status === 'today' ? 'active' : ''}" data-status="today">Today</button>
          <button class="pill pill-next ${item.status === 'next' ? 'active' : ''}" data-status="next">Next</button>
          <button class="pill pill-waiting ${item.status === 'waiting' ? 'active' : ''}" data-status="waiting">Waiting</button>
          <button class="pill pill-someday ${item.status === 'someday' ? 'active' : ''}" data-status="someday">Someday</button>
          <button class="pill pill-done ${item.status === 'done' ? 'active' : ''}" data-status="done">Done</button>
          ${showTop3Toggle && item.status === 'today' ? `
            <button class="top3-toggle ${item.isTop3 ? 'in-top3' : ''}">${item.isTop3 ? '- Top 3' : '+ Top 3'}</button>
          ` : ''}
          ${isTop3 ? `<button class="top3-toggle in-top3">- Top 3</button>` : ''}
        </div>
      </li>
    `;
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
        if (result.error) {
          alert(result.error);
        } else {
          this.render();
        }
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
    if (item.status === status) {
      await db.updateItem(id, { status: 'inbox' });
    } else {
      const updates = { status };
      if (status !== 'today') {
        updates.isTop3 = false;
        updates.top3Order = null;
      }
      await db.updateItem(id, updates);
    }
    await this.render();
  }

  // ==================== KEYBOARD SHORTCUTS ====================

  handleGlobalKeydown(e) {
    // Don't handle shortcuts when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
      return;
    }

    // Only handle shortcuts on inbox page with selected item
    if (this.currentPage !== 'inbox' || !this.selectedItemId) return;

    const key = e.key.toUpperCase();
    const shortcuts = {
      'T': 'today',
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
        });
      }
    }
  }

  // ==================== EDIT MODAL ====================

  async openEditModal(id) {
    this.editingItemId = id;
    const item = await db.getItem(id);

    document.getElementById('edit-text').value = item.text;
    document.getElementById('edit-due').value = item.dueDate || '';
    document.getElementById('edit-estimate').value = item.estimate || '';
    document.getElementById('edit-tag').value = item.tag || '';

    document.getElementById('edit-modal').classList.remove('hidden');
    document.getElementById('edit-text').focus();
  }

  closeEditModal() {
    this.editingItemId = null;
    document.getElementById('edit-modal').classList.add('hidden');
  }

  async saveEditItem() {
    if (!this.editingItemId) return;

    const updates = {
      text: document.getElementById('edit-text').value.trim(),
      dueDate: document.getElementById('edit-due').value || null,
      estimate: parseInt(document.getElementById('edit-estimate').value) || null,
      tag: document.getElementById('edit-tag').value || null
    };

    await db.updateItem(this.editingItemId, updates);
    this.closeEditModal();
    await this.render();
  }

  async deleteEditItem() {
    if (!this.editingItemId) return;
    if (confirm('Delete this item?')) {
      await db.deleteItem(this.editingItemId);
      this.closeEditModal();
      this.selectedItemId = null;
      await this.render();
    }
  }

  // ==================== ROUTINES ====================

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
      const markDone = confirm('Focus session complete! Mark task as done?');
      if (markDone) {
        await db.updateItem(this.selectedItemId, {
          status: 'done',
          isTop3: false,
          top3Order: null
        });
      }
    }

    this.selectedItemId = null;
    await this.render();
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
    } catch (err) {
      alert('Error importing data: ' + err.message);
    }

    e.target.value = '';
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
