/**
 * Battle Plan - IndexedDB Storage Layer
 * Army-style prioritization with ACE+LMT scoring
 * Version 4 - With proper Today logic, Top 3 per-day, and tiered sorting
 */

const DB_NAME = 'BattlePlanDB';
const DB_VERSION = 4;

// Constants
const ESTIMATE_BUCKETS = [15, 30, 60, 90, 120, 180];
const CONFIDENCE_MULTIPLIERS = { high: 1.1, medium: 1.3, low: 1.6 };
const CONFIDENCE_LEVELS = ['high', 'medium', 'low'];

const DEFAULT_SETTINGS = {
  timerDefault: 25,
  weekday_capacity_minutes: 180,
  weekend_capacity_minutes: 360,
  always_plan_slack_percent: 30,
  auto_roll_tomorrow_to_today: true,
  top3_auto_clear_daily: true
};

class BattlePlanDB {
  constructor() {
    this.db = null;
    this._renderCache = null;
    this.ready = this.init();
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion;

        // Create or update items store
        if (!db.objectStoreNames.contains('items')) {
          const itemStore = db.createObjectStore('items', { keyPath: 'id' });
          itemStore.createIndex('status', 'status', { unique: false });
          itemStore.createIndex('created_at', 'created_at', { unique: false });
          itemStore.createIndex('isTop3', 'isTop3', { unique: false });
          itemStore.createIndex('tag', 'tag', { unique: false });
          itemStore.createIndex('scheduled_for_date', 'scheduled_for_date', { unique: false });
          itemStore.createIndex('dueDate', 'dueDate', { unique: false });
        } else if (oldVersion < 4) {
          // Add new indexes for v4
          const tx = event.target.transaction;
          const itemStore = tx.objectStore('items');
          if (!itemStore.indexNames.contains('scheduled_for_date')) {
            itemStore.createIndex('scheduled_for_date', 'scheduled_for_date', { unique: false });
          }
          if (!itemStore.indexNames.contains('dueDate')) {
            itemStore.createIndex('dueDate', 'dueDate', { unique: false });
          }
        }

        if (!db.objectStoreNames.contains('routines')) {
          db.createObjectStore('routines', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }

        if (!db.objectStoreNames.contains('calibration_history')) {
          const calStore = db.createObjectStore('calibration_history', { keyPath: 'id' });
          calStore.createIndex('tag', 'tag', { unique: false });
          calStore.createIndex('completed_at', 'completed_at', { unique: false });
        }
      };
    });
  }

  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  // ==================== DATE HELPERS ====================

  getToday() {
    return new Date().toISOString().split('T')[0];
  }

  getTomorrow() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  }

  isWeekend() {
    const day = new Date().getDay();
    return day === 0 || day === 6;
  }

  // ==================== ITEMS ====================

  async addItem(text) {
    await this.ready;
    const now = new Date().toISOString();
    const item = {
      id: this.generateId(),
      text: text.trim(),
      status: 'inbox',
      tag: null,
      next_action: null,
      // ACE scores
      A: null,
      C: null,
      E: null,
      // LMT bonuses
      L: null,
      M: null,
      T: null,
      // Time planning
      estimate_bucket: null,
      confidence: null,
      actual_bucket: null,
      // Top 3 (with per-day state)
      isTop3: false,
      top3Order: null,
      top3Date: null,
      top3Locked: false,
      // Scheduling
      scheduled_for_date: null,
      dueDate: null,
      // Recurrence
      recurrence: null, // 'daily', 'weekly', 'monthly', or null
      recurrence_day: null, // 0-6 for weekly (0=Sunday), 1-31 for monthly
      // Waiting
      waiting_on: null,
      // Notes
      notes: null,
      // Sub-tasks
      parent_id: null, // ID of parent task, null if top-level
      // Timestamps
      created_at: now,
      updated_at: now
    };

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readwrite');
      const store = tx.objectStore('items');
      const request = store.add(item);
      request.onsuccess = () => {
        this.scheduleAutoBackup();
        resolve(item);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getItem(id) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readonly');
      const store = tx.objectStore('items');
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async updateItem(id, updates) {
    await this.ready;
    const item = await this.getItem(id);
    if (!item) return null;

    const updated = {
      ...item,
      ...updates,
      updated_at: new Date().toISOString()
    };

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readwrite');
      const store = tx.objectStore('items');
      const request = store.put(updated);
      request.onsuccess = () => {
        this.scheduleAutoBackup();
        resolve(updated);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async batchUpdateItems(updates) {
    await this.ready;
    if (!updates || updates.length === 0) return [];

    // First, read all items that need updating
    const ids = updates.map(u => u.id);
    const items = await new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readonly');
      const store = tx.objectStore('items');
      const results = [];
      let pending = ids.length;

      for (const id of ids) {
        const request = store.get(id);
        request.onsuccess = () => {
          results.push(request.result);
          if (--pending === 0) resolve(results);
        };
        request.onerror = () => reject(request.error);
      }
    });

    // Build a map for quick lookup
    const itemMap = new Map();
    for (const item of items) {
      if (item) itemMap.set(item.id, item);
    }

    // Apply all updates in a single readwrite transaction
    const now = new Date().toISOString();
    const updatedItems = [];

    await new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readwrite');
      const store = tx.objectStore('items');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);

      for (const { id, changes } of updates) {
        const existing = itemMap.get(id);
        if (!existing) continue;

        const updated = {
          ...existing,
          ...changes,
          updated_at: now
        };
        store.put(updated);
        updatedItems.push(updated);
      }
    });

    if (updatedItems.length > 0) {
      this.scheduleAutoBackup();
    }

    return updatedItems;
  }

  async deleteItem(id) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readwrite');
      const store = tx.objectStore('items');
      const request = store.delete(id);
      request.onsuccess = () => {
        this.scheduleAutoBackup();
        resolve(true);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // Restore a previously deleted item (for undo functionality)
  async restoreItem(item) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readwrite');
      const store = tx.objectStore('items');
      const request = store.put(item);
      request.onsuccess = () => {
        this.scheduleAutoBackup();
        resolve(item);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async beginRenderCache() {
    await this.ready;
    this._renderCache = await new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readonly');
      const store = tx.objectStore('items');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  endRenderCache() {
    this._renderCache = null;
  }

  async getAllItems() {
    if (this._renderCache) {
      return this._renderCache.map(item => ({ ...item }));
    }
    await this.ready;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readonly');
      const store = tx.objectStore('items');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  // ==================== SUB-TASKS ====================

  async getSubtasks(parentId) {
    const allItems = await this.getAllItems();
    return allItems.filter(item => item.parent_id === parentId);
  }

  async addSubtask(parentId, text) {
    await this.ready;
    const parent = await this.getItem(parentId);
    if (!parent) return null;

    const now = new Date().toISOString();
    const subtask = {
      id: this.generateId(),
      text: text.trim(),
      status: parent.status, // Inherit parent's status
      tag: parent.tag, // Inherit parent's tag
      next_action: null,
      A: null, C: null, E: null,
      L: null, M: null, T: null,
      estimate_bucket: null,
      confidence: null,
      actual_bucket: null,
      isTop3: false,
      top3Order: null,
      top3Date: null,
      top3Locked: false,
      scheduled_for_date: parent.scheduled_for_date,
      dueDate: parent.dueDate, // Inherit due date
      recurrence: null,
      recurrence_day: null,
      waiting_on: null,
      notes: null,
      parent_id: parentId,
      created_at: now,
      updated_at: now
    };

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readwrite');
      const store = tx.objectStore('items');
      const request = store.add(subtask);
      request.onsuccess = () => {
        this.scheduleAutoBackup();
        resolve(subtask);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getSubtaskProgress(parentId) {
    const subtasks = await this.getSubtasks(parentId);
    if (subtasks.length === 0) return null;
    const completed = subtasks.filter(t => t.status === 'done').length;
    return { completed, total: subtasks.length };
  }

  // ==================== FULLY RATED PREDICATE ====================

  /**
   * Strict definition of "fully rated"
   * A, C, E must be numbers (1-5)
   * L, M, T must be numbers (0-2, 0 is allowed)
   * estimate_bucket must be set
   * confidence must be high|medium|low
   */
  isRated(item) {
    return (
      typeof item.A === 'number' && item.A >= 1 && item.A <= 5 &&
      typeof item.C === 'number' && item.C >= 1 && item.C <= 5 &&
      typeof item.E === 'number' && item.E >= 1 && item.E <= 5 &&
      typeof item.L === 'number' && item.L >= 0 && item.L <= 2 &&
      typeof item.M === 'number' && item.M >= 0 && item.M <= 2 &&
      typeof item.T === 'number' && item.T >= 0 && item.T <= 2 &&
      typeof item.estimate_bucket === 'number' && item.estimate_bucket > 0 &&
      CONFIDENCE_LEVELS.includes(item.confidence)
    );
  }

  isMonster(item) {
    return item.estimate_bucket >= 90 || item.confidence === 'low';
  }

  // Get total estimate including subtasks
  async getEffectiveEstimate(item) {
    const baseEstimate = item.estimate_bucket || 0;
    const subtasks = await this.getSubtasks(item.id);
    const subtaskTime = subtasks.reduce((sum, s) => sum + (s.estimate_bucket || 0), 0);
    return baseEstimate + subtaskTime;
  }

  // Check if item is a monster including subtask time
  async isMonsterAsync(item) {
    if (item.confidence === 'low') return true;
    const effectiveEstimate = await this.getEffectiveEstimate(item);
    return effectiveEstimate >= 90;
  }

  // ==================== SCORING (ACE+LMT) ====================

  calculateScores(item) {
    if (item.A == null || item.C == null || item.E == null) {
      return { ace_score: null, lmt_bonus: null, priority_score: null };
    }

    const ace_score = (item.A * 2) + (item.C * 2) - item.E;
    const lmt_bonus = (item.L || 0) + (item.M || 0) + (item.T || 0);
    const priority_score = ace_score + lmt_bonus;

    return { ace_score, lmt_bonus, priority_score };
  }

  calculateBadges(item) {
    const badges = [];

    if (item.C === 5) badges.push('URGENT');
    if (item.A === 5 && item.C >= 4) badges.push('CRITICAL');
    if (this.isMonster(item)) badges.push('MONSTER');
    if (item.L === 2) badges.push('LEVERAGE');
    if (item.E >= 4) badges.push('FRICTION');

    return badges;
  }

  // ==================== TIME PLANNING ====================

  async getCalibrationFactor(tag) {
    await this.ready;
    const effectiveTag = tag || 'Other';
    const history = await this.getCalibrationHistory(effectiveTag);

    if (history.length === 0) return 1.0;

    // Filter out invalid records
    const validHistory = history.filter(h =>
      h.estimate_bucket > 0 && h.actual_bucket > 0
    );

    if (validHistory.length === 0) return 1.0;

    const ratios = validHistory.map(h => h.actual_bucket / h.estimate_bucket);
    const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;

    // Clamp to [1.0, 2.0]
    return Math.max(1.0, Math.min(2.0, avg));
  }

  async getCalibrationHistory(tag) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('calibration_history', 'readonly');
      const store = tx.objectStore('calibration_history');
      const index = store.index('tag');
      const request = index.getAll(tag);
      request.onsuccess = () => {
        const results = request.result || [];
        // Sort by completed_at desc and take last 20
        results.sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
        resolve(results.slice(0, 20));
      };
      request.onerror = () => reject(request.error);
    });
  }

  async addCalibrationEntry(tag, estimate_bucket, actual_bucket) {
    await this.ready;

    // Skip if invalid data
    if (!estimate_bucket || estimate_bucket <= 0) return null;
    if (!actual_bucket || actual_bucket <= 0) return null;

    const entry = {
      id: this.generateId(),
      tag: tag || 'Other',
      estimate_bucket,
      actual_bucket,
      completed_at: new Date().toISOString()
    };

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('calibration_history', 'readwrite');
      const store = tx.objectStore('calibration_history');
      const request = store.add(entry);
      request.onsuccess = () => resolve(entry);
      request.onerror = () => reject(request.error);
    });
  }

  async getBufferedMinutes(item) {
    if (!item.estimate_bucket || !item.confidence) return null;

    const multiplier = CONFIDENCE_MULTIPLIERS[item.confidence] || 1.3;
    const calibrationFactor = await this.getCalibrationFactor(item.tag);
    const buffered = item.estimate_bucket * multiplier * calibrationFactor;

    // Round up to nearest 5 minutes
    return Math.ceil(buffered / 5) * 5;
  }

  // ==================== CAPACITY ====================

  async getUsableCapacity() {
    const isWeekend = this.isWeekend();
    const capacityKey = isWeekend ? 'weekend_capacity_minutes' : 'weekday_capacity_minutes';
    const capacity = await this.getSetting(capacityKey, DEFAULT_SETTINGS[capacityKey]);
    const slackPercent = await this.getSetting('always_plan_slack_percent', DEFAULT_SETTINGS.always_plan_slack_percent);

    return Math.round(capacity * (1 - slackPercent / 100));
  }

  // ==================== TODAY LOGIC ====================

  /**
   * Today query logic:
   * - status === 'today' OR
   * - scheduled_for_date <= today (and status is not done)
   * - If scheduled_for_date is null, only shows based on status
   */
  async getTodayItems() {
    const items = await this.getAllItems();
    const today = this.getToday();

    return items.filter(i => {
      // Exclude subtasks from main lists
      if (i.parent_id) return false;
      if (i.status === 'done') return false;

      // Explicit today status
      if (i.status === 'today') return true;

      // Scheduled for today or earlier (overdue)
      if (i.scheduled_for_date && i.scheduled_for_date <= today) return true;

      return false;
    });
  }

  /**
   * Check if an item is overdue
   * Overdue = scheduled_for_date < today AND not done
   */
  isOverdue(item) {
    if (item.status === 'done') return false;
    if (!item.scheduled_for_date) return false;
    return item.scheduled_for_date < this.getToday();
  }

  // ==================== TOP 3 SELECTION ====================

  async getTop3Items() {
    const items = await this.getAllItems();
    const today = this.getToday();

    return items
      .filter(i => i.isTop3 && i.top3Date === today && i.status !== 'done')
      .sort((a, b) => (a.top3Order || 0) - (b.top3Order || 0));
  }

  /**
   * Suggest Top 3 algorithm:
   * 1. Keep locked Top 3 items (if still eligible)
   * 2. Fill remaining slots with highest priority rated tasks
   * 3. Respect monster rule (max 1 monster)
   * 4. Respect capacity
   */
  async suggestTop3() {
    const today = this.getToday();
    const todayItems = await this.getTodayItems();
    const usableCapacity = await this.getUsableCapacity();

    // Separate locked vs unlocked Top 3
    const lockedTop3 = todayItems.filter(i =>
      i.isTop3 && i.top3Date === today && i.top3Locked && this.isRated(i)
    );

    // Get rated items not currently locked in Top 3
    const candidates = todayItems.filter(i =>
      this.isRated(i) &&
      !(i.isTop3 && i.top3Date === today && i.top3Locked)
    );

    // Calculate scores for candidates (including subtask time for monster check)
    const scored = await Promise.all(candidates.map(async item => {
      const scores = this.calculateScores(item);
      const bufferedMinutes = await this.getBufferedMinutes(item);
      const isUrgent = item.C === 5;
      const isMonster = await this.isMonsterAsync(item);
      return { ...item, ...scores, bufferedMinutes, isUrgent, isMonster };
    }));

    // Sort: URGENT first, then by priority_score descending
    scored.sort((a, b) => {
      if (a.isUrgent && !b.isUrgent) return -1;
      if (!a.isUrgent && b.isUrgent) return 1;
      return (b.priority_score || 0) - (a.priority_score || 0);
    });

    // Calculate locked items stats
    let usedMinutes = 0;
    let monsterCount = 0;
    const selected = [];

    for (const item of lockedTop3) {
      const buffered = await this.getBufferedMinutes(item);
      usedMinutes += buffered || 0;
      if (await this.isMonsterAsync(item)) monsterCount++;
      selected.push({ ...item, bufferedMinutes: buffered });
    }

    // Greedy selection for remaining slots
    for (const item of scored) {
      if (selected.length >= 3) break;

      // Skip if already selected (was locked)
      if (selected.find(s => s.id === item.id)) continue;

      // Monster rule: max 1 MONSTER
      if (item.isMonster && monsterCount >= 1) continue;

      // Capacity check
      if (usedMinutes + item.bufferedMinutes <= usableCapacity) {
        selected.push(item);
        usedMinutes += item.bufferedMinutes;
        if (item.isMonster) monsterCount++;
      }
    }

    // Generate appropriate message
    let message = null;
    if (selected.length === 0 && scored.length > 0) {
      // Check if all candidates are monsters
      const allMonsters = scored.every(s => s.isMonster);
      if (allMonsters) {
        message = 'Everything is a MONSTER. Break a task down or lower estimates.';
      } else {
        message = 'No tasks fit within capacity. Reduce estimates or increase capacity.';
      }
    } else if (selected.length < 3 && scored.length >= 3) {
      message = `Only ${selected.length} task${selected.length === 1 ? '' : 's'} fit within today's capacity. Break down a MONSTER or lower estimates.`;
    }

    return {
      suggested: selected,
      usedMinutes,
      usableCapacity,
      message,
      monsterCount,
      lockedCount: lockedTop3.length
    };
  }

  async applyTop3Suggestion(suggestion) {
    const today = this.getToday();
    const allItems = await this.getAllItems();

    // Clear non-locked Top 3 from today
    for (const item of allItems) {
      if (item.isTop3 && item.top3Date === today && !item.top3Locked) {
        await this.updateItem(item.id, {
          isTop3: false,
          top3Order: null,
          top3Date: null
        });
      }
    }

    // Re-normalize order: locked items keep their order, new items fill gaps
    let order = 0;
    for (const item of suggestion.suggested) {
      await this.updateItem(item.id, {
        isTop3: true,
        top3Order: order,
        top3Date: today
      });
      order++;
    }

    return suggestion;
  }

  async setTop3(id, isTop3, manualToggle = true) {
    await this.ready;
    const item = await this.getItem(id);
    const today = this.getToday();

    if (isTop3) {
      const currentTop3 = await this.getTop3Items();
      const usableCapacity = await this.getUsableCapacity();

      // Check monster rule (including subtask time)
      const isMonster = await this.isMonsterAsync(item);
      let currentMonsterCount = 0;
      for (const i of currentTop3) {
        if (await this.isMonsterAsync(i)) currentMonsterCount++;
      }

      if (isMonster && currentMonsterCount >= 1 && !currentTop3.find(i => i.id === id)) {
        return {
          error: 'MONSTER_LIMIT',
          message: 'Only 1 MONSTER allowed in Top 3. Break it down or remove the other MONSTER first.'
        };
      }

      // Check count limit
      if (currentTop3.length >= 3 && !currentTop3.find(i => i.id === id)) {
        return { error: 'TOP3_FULL', message: 'Top 3 is full. Remove an item first.' };
      }

      const order = currentTop3.length;

      // If manually toggled, auto-lock
      return this.updateItem(id, {
        isTop3: true,
        top3Order: order,
        top3Date: today,
        top3Locked: manualToggle
      });
    } else {
      return this.updateItem(id, {
        isTop3: false,
        top3Order: null,
        top3Date: null,
        top3Locked: false
      });
    }
  }

  async getTop3Stats() {
    const top3Items = await this.getTop3Items();
    const usableCapacity = await this.getUsableCapacity();

    let totalBuffered = 0;
    let monsterCount = 0;
    let lockedCount = 0;

    for (const item of top3Items) {
      const buffered = await this.getBufferedMinutes(item);
      totalBuffered += buffered || 0;
      if (this.isMonster(item)) monsterCount++;
      if (item.top3Locked) lockedCount++;
    }

    const isOverCapacity = totalBuffered > usableCapacity;

    return {
      totalBuffered,
      usableCapacity,
      monsterCount,
      lockedCount,
      isOverCapacity,
      top3Count: top3Items.length
    };
  }

  // ==================== VIEW QUERIES ====================

  async getInboxItems() {
    const items = await this.getAllItems();
    return items.filter(i => i.status === 'inbox');
  }

  async getTomorrowItems() {
    const items = await this.getAllItems();
    const tomorrow = this.getTomorrow();
    return items.filter(i =>
      !i.parent_id && i.status !== 'done' && i.scheduled_for_date === tomorrow
    );
  }

  async getItemsByStatus(status) {
    const items = await this.getAllItems();
    return items.filter(i => !i.parent_id && i.status === status);
  }

  // ==================== STATS ====================

  async getTodayStats() {
    const items = await this.getAllItems();
    const today = this.getToday();

    const todayItems = await this.getTodayItems();

    const ratedCount = todayItems.filter(i => this.isRated(i)).length;
    const unratedCount = todayItems.length - ratedCount;

    const overdueItems = items.filter(i => this.isOverdue(i));

    const top3Stats = await this.getTop3Stats();

    return {
      totalTasks: todayItems.length,
      ratedCount,
      unratedCount,
      overdueCount: overdueItems.length,
      ...top3Stats
    };
  }

  // ==================== SCHEDULING ====================

  async setTomorrow(id) {
    const tomorrow = this.getTomorrow();
    return this.updateItem(id, {
      status: 'tomorrow',
      scheduled_for_date: tomorrow,
      // Clear Top 3 when moved out of today
      isTop3: false,
      top3Order: null,
      top3Date: null,
      top3Locked: false
    });
  }

  async setToday(id) {
    const today = this.getToday();
    return this.updateItem(id, {
      status: 'today',
      scheduled_for_date: today
    });
  }

  // ==================== ROLLOVER / DAILY MAINTENANCE ====================

  async runDailyMaintenance() {
    await this.ready;
    const today = this.getToday();
    const items = await this.getAllItems();

    const autoClearTop3 = await this.getSetting('top3_auto_clear_daily', true);

    let overdueCount = 0;
    let rolledCount = 0;
    let clearedTop3Count = 0;

    for (const item of items) {
      if (item.status === 'done') continue;

      // Count overdue
      if (this.isOverdue(item)) {
        overdueCount++;
      }

      // Auto-move scheduled items to today when their date arrives
      if (item.scheduled_for_date && item.scheduled_for_date <= today && item.status !== 'today') {
        await this.updateItem(item.id, { status: 'today' });
        rolledCount++;
      }

      // Auto-move items to today when due date is within 7 days
      if (item.dueDate && item.status !== 'today') {
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const due = new Date(item.dueDate + 'T00:00:00');
        const daysUntilDue = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
        if (daysUntilDue <= 7) {
          await this.updateItem(item.id, { status: 'today' });
          rolledCount++;
        }
      }

      // Clear stale Top 3 (from previous days)
      if (autoClearTop3 && item.isTop3 && item.top3Date && item.top3Date !== today) {
        if (!item.top3Locked) {
          await this.updateItem(item.id, {
            isTop3: false,
            top3Order: null,
            top3Date: null
          });
          clearedTop3Count++;
        }
      }
    }

    return { overdueCount, rolledCount, clearedTop3Count };
  }

  // Alias for backward compatibility
  async runRollover() {
    return this.runDailyMaintenance();
  }

  // ==================== TASK COMPLETION ====================

  async completeTask(id, actual_bucket, skipRecurrence = false) {
    const item = await this.getItem(id);
    if (!item) return null;

    // Record calibration if we have both buckets
    if (item.estimate_bucket && actual_bucket) {
      await this.addCalibrationEntry(item.tag, item.estimate_bucket, actual_bucket);
    }

    // Create next recurring instance if task is recurring (unless skipping)
    if (item.recurrence && !skipRecurrence) {
      await this.createNextRecurringTask(item);
    }

    return this.updateItem(id, {
      status: 'done',
      actual_bucket,
      isTop3: false,
      top3Order: null,
      top3Date: null,
      top3Locked: false
    });
  }

  /**
   * Archive old done tasks (older than specified days)
   */
  async archiveDoneTasks(olderThanDays = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const items = await this.getAllItems();
    const toArchive = items.filter(item =>
      item.status === 'done' &&
      !item.archived &&
      new Date(item.updated_at) < cutoffDate
    );

    let archived = 0;
    for (const item of toArchive) {
      await this.updateItem(item.id, { archived: true });
      archived++;
    }

    return archived;
  }

  /**
   * Get done items (exclude archived by default)
   */
  async getDoneItems(includeArchived = false) {
    const items = await this.getAllItems();
    return items.filter(item =>
      item.status === 'done' &&
      (includeArchived || !item.archived)
    );
  }

  async createNextRecurringTask(originalItem) {
    const nextDate = this.getNextRecurrenceDate(originalItem);
    const now = new Date().toISOString();

    const newItem = {
      id: this.generateId(),
      text: originalItem.text,
      status: 'next', // Recurring tasks go to Next by default
      tag: originalItem.tag,
      next_action: originalItem.next_action,
      // Copy ACE+LMT scores
      A: originalItem.A,
      C: originalItem.C,
      E: originalItem.E,
      L: originalItem.L,
      M: originalItem.M,
      T: originalItem.T,
      // Copy time planning
      estimate_bucket: originalItem.estimate_bucket,
      confidence: originalItem.confidence,
      actual_bucket: null,
      // Reset Top 3
      isTop3: false,
      top3Order: null,
      top3Date: null,
      top3Locked: false,
      // Set next scheduled date
      scheduled_for_date: nextDate,
      dueDate: null,
      // Copy recurrence settings
      recurrence: originalItem.recurrence,
      recurrence_day: originalItem.recurrence_day,
      waiting_on: null,
      // Timestamps
      created_at: now,
      updated_at: now
    };

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readwrite');
      const store = tx.objectStore('items');
      const request = store.add(newItem);
      request.onsuccess = () => {
        this.scheduleAutoBackup();
        resolve(newItem);
      };
      request.onerror = () => reject(request.error);
    });
  }

  getNextRecurrenceDate(item) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let nextDate = new Date(today);

    switch (item.recurrence) {
      case 'daily':
        nextDate.setDate(nextDate.getDate() + 1);
        break;

      case 'weekly':
        // Find next occurrence of the specified day
        const targetDay = item.recurrence_day || 0; // 0 = Sunday
        let daysUntilNext = targetDay - today.getDay();
        if (daysUntilNext <= 0) daysUntilNext += 7;
        nextDate.setDate(nextDate.getDate() + daysUntilNext);
        break;

      case 'monthly':
        // Next month on the same date (handle month-end edge cases)
        const targetDate = item.recurrence_day || today.getDate();
        // Set to 1st first to avoid overflow when changing months (e.g., Jan 31 -> Mar 3)
        nextDate.setDate(1);
        nextDate.setMonth(nextDate.getMonth() + 1);
        // Get days in the target month
        const daysInMonth = new Date(nextDate.getFullYear(), nextDate.getMonth() + 1, 0).getDate();
        nextDate.setDate(Math.min(targetDate, daysInMonth));
        break;

      default:
        nextDate.setDate(nextDate.getDate() + 1);
    }

    return nextDate.toISOString().split('T')[0];
  }

  // ==================== PRESETS ====================

  getPresets() {
    return {
      'mission-critical': {
        name: 'Mission-critical now',
        A: 5, C: 5, E: 3, L: 1, M: 1, T: 1,
        estimate_bucket: 60, confidence: 'medium'
      },
      'money-maker': {
        name: 'Money-maker',
        A: 5, C: 4, E: 2, L: 1, M: 2, T: 1,
        estimate_bucket: 60, confidence: 'medium'
      },
      'admin-tax': {
        name: 'Admin tax',
        A: 3, C: 4, E: 4, L: 0, M: 1, T: 0,
        estimate_bucket: 90, confidence: 'low'
      },
      'quick-win': {
        name: 'Quick win',
        A: 2, C: 3, E: 1, L: 0, M: 2, T: 2,
        estimate_bucket: 15, confidence: 'high'
      },
      'waiting-on-others': {
        name: 'Waiting on others',
        A: 3, C: 3, E: 2, L: 0, M: 0, T: 2,
        estimate_bucket: 15, confidence: 'high',
        status: 'waiting'
      }
    };
  }

  async applyPreset(id, presetKey) {
    const presets = this.getPresets();
    const preset = presets[presetKey];
    if (!preset) return null;

    const updates = { ...preset };
    delete updates.name;

    return this.updateItem(id, updates);
  }

  // ==================== SEARCH ====================

  async searchItems(query, status = null) {
    const items = await this.getAllItems();
    const q = query.toLowerCase().trim();

    return items.filter(item => {
      const matchesText = item.text.toLowerCase().includes(q) ||
                          (item.next_action && item.next_action.toLowerCase().includes(q));
      const matchesStatus = status === null || item.status === status;
      return matchesText && matchesStatus;
    });
  }

  // ==================== ROUTINES ====================

  async addRoutine(name) {
    await this.ready;
    const routine = {
      id: this.generateId(),
      name: name.trim(),
      items: [],
      created: new Date().toISOString()
    };

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('routines', 'readwrite');
      const store = tx.objectStore('routines');
      const request = store.add(routine);
      request.onsuccess = () => {
        this.scheduleAutoBackup();
        resolve(routine);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getRoutine(id) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('routines', 'readonly');
      const store = tx.objectStore('routines');
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async updateRoutine(id, updates) {
    await this.ready;
    const routine = await this.getRoutine(id);
    if (!routine) return null;

    const updated = { ...routine, ...updates };

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('routines', 'readwrite');
      const store = tx.objectStore('routines');
      const request = store.put(updated);
      request.onsuccess = () => {
        this.scheduleAutoBackup();
        resolve(updated);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async deleteRoutine(id) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('routines', 'readwrite');
      const store = tx.objectStore('routines');
      const request = store.delete(id);
      request.onsuccess = () => {
        this.scheduleAutoBackup();
        resolve(true);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getAllRoutines() {
    await this.ready;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('routines', 'readonly');
      const store = tx.objectStore('routines');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async runRoutine(id) {
    await this.ready;
    const routine = await this.getRoutine(id);
    if (!routine) return [];

    const today = this.getToday();
    const createdItems = [];

    for (const itemText of routine.items) {
      const item = await this.addItem(itemText);
      await this.updateItem(item.id, {
        status: 'today',
        scheduled_for_date: today
      });
      createdItems.push(item);
    }
    return createdItems;
  }

  // ==================== SETTINGS ====================

  async getSetting(key, defaultValue = null) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('settings', 'readonly');
      const store = tx.objectStore('settings');
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result?.value ?? defaultValue);
      request.onerror = () => reject(request.error);
    });
  }

  async setSetting(key, value) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('settings', 'readwrite');
      const store = tx.objectStore('settings');
      const request = store.put({ key, value });
      request.onsuccess = () => resolve(value);
      request.onerror = () => reject(request.error);
    });
  }

  // ==================== EXPORT/IMPORT ====================

  async exportData() {
    await this.ready;
    const items = await this.getAllItems();
    const routines = await this.getAllRoutines();

    // Get all settings
    const settings = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      settings[key] = await this.getSetting(key, DEFAULT_SETTINGS[key]);
    }

    // Get calibration history
    const calibrationHistory = await new Promise((resolve, reject) => {
      const tx = this.db.transaction('calibration_history', 'readonly');
      const store = tx.objectStore('calibration_history');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });

    return {
      version: 4,
      exported: new Date().toISOString(),
      items,
      routines,
      settings,
      calibrationHistory
    };
  }

  // Whitelist of allowed item fields (prevents prototype pollution)
  static ALLOWED_ITEM_FIELDS = new Set([
    'id', 'text', 'status', 'tag', 'next_action', 'notes',
    'A', 'C', 'E', 'L', 'M', 'T',
    'estimate_bucket', 'confidence', 'actual_bucket',
    'isTop3', 'top3Order', 'top3Date', 'top3Locked',
    'scheduled_for_date', 'dueDate',
    'recurrence', 'recurrence_day',
    'waiting_on', 'parent_id', 'archived',
    'created_at', 'updated_at', 'created'
  ]);

  static ALLOWED_ROUTINE_FIELDS = new Set([
    'id', 'name', 'items', 'created', 'created_at', 'updated_at'
  ]);

  static ALLOWED_CALIBRATION_FIELDS = new Set([
    'id', 'tag', 'estimate_bucket', 'actual_bucket', 'completed_at'
  ]);

  static ALLOWED_SETTINGS_KEYS = new Set([
    'timerDefault', 'weekday_capacity_minutes', 'weekend_capacity_minutes',
    'always_plan_slack_percent', 'auto_roll_tomorrow_to_today', 'top3_auto_clear_daily'
  ]);

  static VALID_STATUSES = ['inbox', 'today', 'tomorrow', 'next', 'waiting', 'someday', 'done'];
  static VALID_CONFIDENCES = ['high', 'medium', 'low', null];
  static VALID_RECURRENCES = ['', 'daily', 'weekly', 'monthly', null];
  static VALID_TAGS = ['Home', 'Army', 'Business', 'Other'];

  /**
   * Safely copy only whitelisted fields from an object (prevents prototype pollution)
   */
  sanitizeItem(item) {
    const sanitized = {};
    for (const key of Object.keys(item)) {
      if (BattlePlanDB.ALLOWED_ITEM_FIELDS.has(key)) {
        sanitized[key] = item[key];
      }
    }
    // Sanitize id - must be alphanumeric string only
    if (sanitized.id) {
      sanitized.id = String(sanitized.id).replace(/[^a-zA-Z0-9_-]/g, '');
    }
    if (!sanitized.id) {
      sanitized.id = this.generateId();
    }
    // Sanitize tag - must be from valid list
    if (sanitized.tag && !BattlePlanDB.VALID_TAGS.includes(sanitized.tag)) {
      sanitized.tag = null;
    }
    // Sanitize text - strip HTML
    if (sanitized.text) {
      sanitized.text = String(sanitized.text).replace(/<[^>]*>/g, '');
    }
    return sanitized;
  }

  sanitizeRoutine(routine) {
    const sanitized = {};
    for (const key of Object.keys(routine)) {
      if (BattlePlanDB.ALLOWED_ROUTINE_FIELDS.has(key)) {
        sanitized[key] = routine[key];
      }
    }
    // Sanitize id
    if (sanitized.id) {
      sanitized.id = String(sanitized.id).replace(/[^a-zA-Z0-9_-]/g, '');
    }
    if (!sanitized.id) {
      sanitized.id = this.generateId();
    }
    // Sanitize name - strip HTML
    if (sanitized.name) {
      sanitized.name = String(sanitized.name).replace(/<[^>]*>/g, '');
    }
    // Sanitize items array - strip HTML from each
    if (Array.isArray(sanitized.items)) {
      sanitized.items = sanitized.items.map(i => String(i).replace(/<[^>]*>/g, ''));
    }
    return sanitized;
  }

  /**
   * Sanitize and validate calibration history entry
   */
  sanitizeCalibrationEntry(entry) {
    const sanitized = {};
    for (const key of Object.keys(entry)) {
      if (BattlePlanDB.ALLOWED_CALIBRATION_FIELDS.has(key)) {
        sanitized[key] = entry[key];
      }
    }

    // Validate required fields
    if (!sanitized.id || typeof sanitized.id !== 'string') {
      sanitized.id = this.generateId();
    }

    // Validate estimate_bucket (must be positive number)
    const estimate = parseInt(sanitized.estimate_bucket);
    if (isNaN(estimate) || estimate <= 0) {
      return null; // Invalid entry, skip it
    }
    sanitized.estimate_bucket = estimate;

    // Validate actual_bucket (must be positive number)
    const actual = parseInt(sanitized.actual_bucket);
    if (isNaN(actual) || actual <= 0) {
      return null; // Invalid entry, skip it
    }
    sanitized.actual_bucket = actual;

    // Validate tag (must be valid tag or default to 'Other')
    if (!sanitized.tag || !BattlePlanDB.VALID_TAGS.includes(sanitized.tag)) {
      sanitized.tag = 'Other';
    }

    // Validate completed_at (must be valid ISO date string)
    if (!sanitized.completed_at || isNaN(Date.parse(sanitized.completed_at))) {
      sanitized.completed_at = new Date().toISOString();
    }

    return sanitized;
  }

  /**
   * Validate item fields have correct types
   */
  validateItemTypes(item) {
    // Validate status
    if (item.status && !BattlePlanDB.VALID_STATUSES.includes(item.status)) {
      item.status = 'inbox';
    }
    // Validate confidence
    if (item.confidence && !BattlePlanDB.VALID_CONFIDENCES.includes(item.confidence)) {
      item.confidence = null;
    }
    // Validate recurrence
    if (item.recurrence && !BattlePlanDB.VALID_RECURRENCES.includes(item.recurrence)) {
      item.recurrence = null;
    }
    // Validate ACE scores (1-5)
    for (const field of ['A', 'C', 'E']) {
      if (item[field] !== null && item[field] !== undefined) {
        const val = parseInt(item[field]);
        if (isNaN(val) || val < 1 || val > 5) {
          item[field] = null;
        } else {
          item[field] = val;
        }
      }
    }
    // Validate LMT scores (0-2)
    for (const field of ['L', 'M', 'T']) {
      if (item[field] !== null && item[field] !== undefined) {
        const val = parseInt(item[field]);
        if (isNaN(val) || val < 0 || val > 2) {
          item[field] = null;
        } else {
          item[field] = val;
        }
      }
    }
    // Validate estimate_bucket
    if (item.estimate_bucket !== null && item.estimate_bucket !== undefined) {
      const val = parseInt(item.estimate_bucket);
      if (isNaN(val) || val < 0) {
        item.estimate_bucket = null;
      } else {
        item.estimate_bucket = val;
      }
    }
    // Validate recurrence_day (0-6 for weekly, 1-31 for monthly)
    if (item.recurrence_day !== null && item.recurrence_day !== undefined) {
      const val = parseInt(item.recurrence_day);
      if (isNaN(val) || val < 0 || val > 31) {
        item.recurrence_day = null;
      } else {
        item.recurrence_day = val;
      }
    }
    // Validate booleans
    item.isTop3 = !!item.isTop3;
    item.top3Locked = !!item.top3Locked;
    item.archived = !!item.archived;

    return item;
  }

  async importData(data, skipConfirm = false) {
    await this.ready;

    if (!data || !data.version) {
      throw new Error('Invalid backup file format');
    }

    // Version check
    if (data.version > 4) {
      throw new Error(`Backup version ${data.version} is newer than supported. Please update the app.`);
    }

    const clearStore = (storeName) => {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    };

    await clearStore('items');
    await clearStore('routines');
    await clearStore('settings');
    await clearStore('calibration_history');

    // Import items with whitelist validation (prevents prototype pollution)
    // Use a single transaction for all items; use put() and deduplicate IDs
    // so a collision from sanitization doesn't abort the entire batch
    if (data.items && data.items.length > 0) {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction('items', 'readwrite');
        const store = tx.objectStore('items');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);

        const seenIds = new Set();
        for (const item of data.items) {
          // Sanitize: only copy whitelisted fields
          const sanitized = this.sanitizeItem(item);

          // Deduplicate: if sanitization caused an ID collision, generate a new one
          if (seenIds.has(sanitized.id)) {
            sanitized.id = this.generateId();
          }
          seenIds.add(sanitized.id);

          // Apply defaults
          const itemWithDefaults = {
            A: null, C: null, E: null, L: null, M: null, T: null,
            estimate_bucket: null, confidence: null, actual_bucket: null,
            next_action: null,
            scheduled_for_date: null,
            top3Date: null,
            top3Locked: false,
            archived: false,
            created_at: sanitized.created || new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...sanitized
          };

          // Validate types
          this.validateItemTypes(itemWithDefaults);

          // Use put() instead of add() so duplicates overwrite rather than aborting
          store.put(itemWithDefaults);
        }
      });
    }

    // Import routines with whitelist validation
    // Use a single transaction; deduplicate IDs and use put() for safety
    if (data.routines && data.routines.length > 0) {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction('routines', 'readwrite');
        const store = tx.objectStore('routines');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);

        const seenIds = new Set();
        for (const routine of data.routines) {
          // Sanitize: only copy whitelisted fields
          const sanitized = this.sanitizeRoutine(routine);

          // Deduplicate IDs
          if (seenIds.has(sanitized.id)) {
            sanitized.id = this.generateId();
          }
          seenIds.add(sanitized.id);

          // Validate routine items is an array of strings
          if (sanitized.items && Array.isArray(sanitized.items)) {
            sanitized.items = sanitized.items.filter(item => typeof item === 'string').slice(0, 100);
          } else {
            sanitized.items = [];
          }

          // Validate name is a string
          if (typeof sanitized.name !== 'string') {
            sanitized.name = 'Imported Routine';
          }

          store.put(sanitized);
        }
      });
    }

    // Import settings with whitelist validation
    if (data.settings) {
      const settingsEntries = Object.entries(data.settings)
        .filter(([key]) => BattlePlanDB.ALLOWED_SETTINGS_KEYS.has(key));

      if (settingsEntries.length > 0) {
        await new Promise((resolve, reject) => {
          const tx = this.db.transaction('settings', 'readwrite');
          const store = tx.objectStore('settings');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);

          for (const [key, value] of settingsEntries) {
            store.put({ key, value });
          }
        });
      }
    }

    // Import calibration history with validation
    // Use a single transaction for all calibration entries
    if (data.calibrationHistory && data.calibrationHistory.length > 0) {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction('calibration_history', 'readwrite');
        const store = tx.objectStore('calibration_history');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);

        const seenIds = new Set();
        for (const entry of data.calibrationHistory) {
          // Sanitize and validate entry
          const sanitized = this.sanitizeCalibrationEntry(entry);
          if (!sanitized) continue; // Skip invalid entries

          // Deduplicate IDs
          if (seenIds.has(sanitized.id)) {
            sanitized.id = this.generateId();
          }
          seenIds.add(sanitized.id);

          store.put(sanitized);
        }
      });
    }

    return true;
  }

  // ==================== DEV TEST HARNESS ====================

  async runDiagnostics() {
    const today = this.getToday();
    const allItems = await this.getAllItems();
    const todayItems = await this.getTodayItems();
    const top3Items = await this.getTop3Items();
    const usableCapacity = await this.getUsableCapacity();

    // Count stats
    const ratedItems = todayItems.filter(i => this.isRated(i));
    const unratedItems = todayItems.filter(i => !this.isRated(i));
    const overdueItems = allItems.filter(i => this.isOverdue(i));
    const monsterItems = todayItems.filter(i => this.isMonster(i));

    // Calculate buffered time for top 3
    let top3BufferedTotal = 0;
    for (const item of top3Items) {
      const buffered = await this.getBufferedMinutes(item);
      top3BufferedTotal += buffered || 0;
    }

    // Sample sort order (first 5)
    const sorted = ratedItems
      .map(item => ({
        text: item.text.substring(0, 30),
        score: this.calculateScores(item).priority_score,
        isMonster: this.isMonster(item),
        isUrgent: item.C === 5
      }))
      .sort((a, b) => {
        if (a.isUrgent && !b.isUrgent) return -1;
        if (!a.isUrgent && b.isUrgent) return 1;
        return (b.score || 0) - (a.score || 0);
      })
      .slice(0, 5);

    const diagnostics = {
      date: today,
      totalItems: allItems.length,
      todayCount: todayItems.length,
      ratedCount: ratedItems.length,
      unratedCount: unratedItems.length,
      overdueCount: overdueItems.length,
      monsterCount: monsterItems.length,
      top3Count: top3Items.length,
      top3BufferedTotal,
      usableCapacity,
      capacityUsedPercent: Math.round((top3BufferedTotal / usableCapacity) * 100),
      sampleSortOrder: sorted
    };

    // Return diagnostics without logging sensitive data to console
    return diagnostics;
  }

  // ==================== AUTO-BACKUP ====================

  scheduleAutoBackup() {
    // Debounce - wait 5 seconds after last change before backing up
    if (this.autoBackupTimeout) {
      clearTimeout(this.autoBackupTimeout);
    }
    this.autoBackupTimeout = setTimeout(() => this.performAutoBackup(), 5000);
  }

  async performAutoBackup() {
    try {
      await this.ready;
      const data = await this.exportData();
      const backups = await this.getAutoBackups();

      // Add new backup with timestamp
      backups.unshift({
        timestamp: new Date().toISOString(),
        data: data
      });

      // Keep only last 3 backups
      while (backups.length > 3) {
        backups.pop();
      }

      // Store in IndexedDB settings (more secure than localStorage)
      await this.setSetting('_autoBackups', backups);
      // Auto-backup completed silently
    } catch (e) {
      // Silently fail - auto-backup is non-critical
    }
  }

  async getAutoBackups() {
    await this.ready;
    // Try IndexedDB first (new secure location)
    const idbBackups = await this.getSetting('_autoBackups', null);
    if (idbBackups) {
      return idbBackups;
    }
    // Fall back to localStorage for migration (one-time)
    const lsBackups = localStorage.getItem('battlePlanAutoBackups');
    if (lsBackups) {
      const parsed = JSON.parse(lsBackups);
      // Migrate to IndexedDB and clear localStorage
      await this.setSetting('_autoBackups', parsed);
      localStorage.removeItem('battlePlanAutoBackups');
      return parsed;
    }
    return [];
  }

  async restoreFromAutoBackup(index = 0) {
    const backups = await this.getAutoBackups();
    if (backups[index]) {
      await this.importData(backups[index].data, true);
      return true;
    }
    return false;
  }
}

// Constants export
const BUCKETS = ESTIMATE_BUCKETS;

// Global database instance
const db = new BattlePlanDB();
