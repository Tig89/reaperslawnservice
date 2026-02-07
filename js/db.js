/**
 * Battle Plan - IndexedDB Storage Layer
 * ACE+LMT scoring, optimized
 * Version 4
 */

const DB_NAME = 'BattlePlanDB';
const DB_VERSION = 4;

const ESTIMATE_BUCKETS = [15, 30, 60, 90, 120, 180];
const CONFIDENCE_MULTIPLIERS = { high: 1.1, medium: 1.3, low: 1.6 };
const CONFIDENCE_LEVELS = ['high', 'medium', 'low'];

const DEFAULT_SETTINGS = {
  timerDefault: 25,
  weekday_capacity_minutes: 180,
  weekend_capacity_minutes: 360,
  always_plan_slack_percent: 30,
  auto_roll_tomorrow_to_today: true,
  top3_auto_clear_daily: true,
  workday_start_hour: 8,
  workday_end_hour: 18
};

class BattlePlanDB {
  /** Default reset values for Top 3 fields — spread into updates to clear top3 state */
  static CLEAR_TOP3 = { isTop3: false, top3Order: null, top3Date: null, top3Locked: false };

  constructor() {
    this.db = null;
    this._renderCache = null;
    this.ready = this.init();
  }

  /** Split items into { rated, unrated } based on whether ACE+LMT scores exist */
  _partitionByRating(items) {
    const rated = [], unrated = [];
    for (const item of items) (this.isRated(item) ? rated : unrated).push(item);
    return { rated, unrated };
  }

  /** In-place sort: urgent items (C=5) first, then by score descending */
  _sortByUrgencyAndScore(items, field = 'priority_score') {
    items.sort((a, b) => {
      if (a.isUrgent && !b.isUrgent) return -1;
      if (!a.isUrgent && b.isUrgent) return 1;
      return (b[field] || 0) - (a[field] || 0);
    });
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { this.db = request.result; resolve(this.db); };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion;

        if (!db.objectStoreNames.contains('items')) {
          const itemStore = db.createObjectStore('items', { keyPath: 'id' });
          itemStore.createIndex('status', 'status', { unique: false });
          itemStore.createIndex('created_at', 'created_at', { unique: false });
          itemStore.createIndex('isTop3', 'isTop3', { unique: false });
          itemStore.createIndex('tag', 'tag', { unique: false });
          itemStore.createIndex('scheduled_for_date', 'scheduled_for_date', { unique: false });
          itemStore.createIndex('dueDate', 'dueDate', { unique: false });
        } else if (oldVersion < 4) {
          const tx = event.target.transaction;
          const itemStore = tx.objectStore('items');
          if (!itemStore.indexNames.contains('scheduled_for_date'))
            itemStore.createIndex('scheduled_for_date', 'scheduled_for_date', { unique: false });
          if (!itemStore.indexNames.contains('dueDate'))
            itemStore.createIndex('dueDate', 'dueDate', { unique: false });
        }

        if (!db.objectStoreNames.contains('routines'))
          db.createObjectStore('routines', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings'))
          db.createObjectStore('settings', { keyPath: 'key' });
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

  // Generic IDB single-request helper
  _req(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      const r = fn(tx.objectStore(store));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  // Calculate time consumed by done tasks today
  _getDoneTodayConsumed(allItems, today) {
    let consumed = 0;
    for (const i of allItems) {
      if (i.status === 'done' &&
        (i.completed_at ? i.completed_at.startsWith(today) : (i.updated_at && i.updated_at.startsWith(today)))) {
        consumed += i.actual_bucket || i.estimate_bucket || 0;
      }
    }
    return consumed;
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
      tag: null, next_action: null,
      A: null, C: null, E: null,
      L: null, M: null, T: null,
      estimate_bucket: null, confidence: null, actual_bucket: null,
      ...BattlePlanDB.CLEAR_TOP3,
      scheduled_for_date: null, dueDate: null,
      recurrence: null, recurrence_day: null,
      waiting_on: null, notes: null, parent_id: null,
      created_at: now, updated_at: now
    };
    await this._req('items', 'readwrite', s => s.add(item));
    this.scheduleAutoBackup();
    return item;
  }

  async getItem(id) {
    await this.ready;
    return this._req('items', 'readonly', s => s.get(id));
  }

  async updateItem(id, updates) {
    await this.ready;
    const item = await this.getItem(id);
    if (!item) return null;
    const updated = { ...item, ...updates, updated_at: new Date().toISOString() };
    await this._req('items', 'readwrite', s => s.put(updated));
    this.scheduleAutoBackup();
    return updated;
  }

  async batchUpdateItems(updates) {
    await this.ready;
    if (!updates || updates.length === 0) return [];

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

    const itemMap = new Map();
    for (const item of items) {
      if (item) itemMap.set(item.id, item);
    }

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
        const updated = { ...existing, ...changes, updated_at: now };
        store.put(updated);
        updatedItems.push(updated);
      }
    });

    if (updatedItems.length > 0) this.scheduleAutoBackup();
    return updatedItems;
  }

  async deleteItem(id) {
    await this.ready;
    await this._req('items', 'readwrite', s => s.delete(id));
    this.scheduleAutoBackup();
    return true;
  }

  async restoreItem(item) {
    await this.ready;
    await this._req('items', 'readwrite', s => s.put(item));
    this.scheduleAutoBackup();
    return item;
  }

  async beginRenderCache() {
    await this.ready;
    this._renderCache = await this._req('items', 'readonly', s => s.getAll());
    this._renderCache = this._renderCache || [];
  }

  endRenderCache() { this._renderCache = null; }

  async getAllItems() {
    if (this._renderCache) return this._renderCache.map(item => ({ ...item }));
    await this.ready;
    const result = await this._req('items', 'readonly', s => s.getAll());
    return result || [];
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
      status: parent.status, tag: parent.tag, next_action: null,
      A: null, C: null, E: null,
      L: null, M: null, T: null,
      estimate_bucket: null, confidence: null, actual_bucket: null,
      ...BattlePlanDB.CLEAR_TOP3,
      scheduled_for_date: parent.scheduled_for_date, dueDate: parent.dueDate,
      recurrence: null, recurrence_day: null,
      waiting_on: null, notes: null, parent_id: parentId,
      created_at: now, updated_at: now
    };
    await this._req('items', 'readwrite', s => s.add(subtask));
    this.scheduleAutoBackup();
    return subtask;
  }

  async getSubtaskProgress(parentId) {
    const subtasks = await this.getSubtasks(parentId);
    if (subtasks.length === 0) return null;
    const completed = subtasks.filter(t => t.status === 'done').length;
    return { completed, total: subtasks.length };
  }

  // ==================== FULLY RATED PREDICATE ====================

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

  async getEffectiveEstimate(item) {
    const baseEstimate = item.estimate_bucket || 0;
    const subtasks = await this.getSubtasks(item.id);
    return baseEstimate + subtasks.reduce((sum, s) => sum + (s.estimate_bucket || 0), 0);
  }

  async isMonsterAsync(item) {
    if (item.confidence === 'low') return true;
    return (await this.getEffectiveEstimate(item)) >= 90;
  }

  // ==================== SCORING (ACE+LMT) ====================

  calculateScores(item) {
    if (item.A == null || item.C == null || item.E == null) {
      return { ace_score: null, lmt_bonus: null, priority_score: null };
    }
    const ace_score = (item.A * 2) + (item.C * 2) - item.E;
    const lmt_bonus = (item.L || 0) + (item.M || 0) + (item.T || 0);
    return { ace_score, lmt_bonus, priority_score: ace_score + lmt_bonus };
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
    const history = await this.getCalibrationHistory(tag || 'Other');
    const validHistory = history.filter(h => h.estimate_bucket > 0 && h.actual_bucket > 0);
    if (validHistory.length === 0) return 1.0;
    const avg = validHistory.reduce((sum, h) => sum + h.actual_bucket / h.estimate_bucket, 0) / validHistory.length;
    return Math.max(1.0, Math.min(2.0, avg));
  }

  async getCalibrationHistory(tag) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('calibration_history', 'readonly');
      const store = tx.objectStore('calibration_history');
      const request = store.index('tag').getAll(tag);
      request.onsuccess = () => {
        const results = (request.result || [])
          .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
        resolve(results.slice(0, 20));
      };
      request.onerror = () => reject(request.error);
    });
  }

  async addCalibrationEntry(tag, estimate_bucket, actual_bucket) {
    await this.ready;
    if (!estimate_bucket || estimate_bucket <= 0 || !actual_bucket || actual_bucket <= 0) return null;
    const entry = {
      id: this.generateId(),
      tag: tag || 'Other',
      estimate_bucket, actual_bucket,
      completed_at: new Date().toISOString()
    };
    await this._req('calibration_history', 'readwrite', s => s.add(entry));
    return entry;
  }

  async getBufferedMinutes(item) {
    if (!item.estimate_bucket || !item.confidence) return null;
    const multiplier = CONFIDENCE_MULTIPLIERS[item.confidence] || 1.3;
    const calibrationFactor = await this.getCalibrationFactor(item.tag);
    return Math.ceil(item.estimate_bucket * multiplier * calibrationFactor / 5) * 5;
  }

  // ==================== AUTO-SCHEDULE ====================

  async autoScheduleToday() {
    const todayItems = await this.getTodayItems();
    const usableCapacity = await this.getUsableCapacity();

    const { rated, unrated } = this._partitionByRating(todayItems);

    const scored = await Promise.all(rated.map(async item => {
      const scores = this.calculateScores(item);
      const bufferedMinutes = await this.getBufferedMinutes(item);
      const isUrgent = item.C === 5;
      const isMonster = await this.isMonsterAsync(item);
      const badges = this.calculateBadges(item);
      return { ...item, ...scores, bufferedMinutes: bufferedMinutes || 0, isUrgent, isMonster, badges };
    }));

    this._sortByUrgencyAndScore(scored);

    const keep = [], overflow = [];
    let usedMinutes = 0;
    for (const item of scored) {
      if (usedMinutes + item.bufferedMinutes <= usableCapacity) {
        keep.push(item);
        usedMinutes += item.bufferedMinutes;
      } else {
        overflow.push(item);
      }
    }

    return { keep, overflow, unrated, usedMinutes, capacity: usableCapacity };
  }

  // ==================== RERACK (shared core) ====================

  /**
   * Core rerack logic shared by rerackAfterCompletion and rerackForTimePressure.
   * Separates protected vs flexible tasks, greedy-fills by value density.
   */
  async _rerackCore({ excludeId = null, lockedIds = [], capacity, defaultReason = 'doesn\'t fit remaining time' }) {
    const todayItems = await this.getTodayItems();
    const today = this.getToday();

    const remaining = todayItems.filter(i => i.id !== excludeId && i.status !== 'done');

    const { rated, unrated } = this._partitionByRating(remaining);

    const scored = await Promise.all(rated.map(async item => {
      const scores = this.calculateScores(item);
      const bufferedMinutes = await this.getBufferedMinutes(item) || 0;
      const isUrgent = item.C === 5;
      const badges = this.calculateBadges(item);
      const isProtected =
        (item.dueDate && item.dueDate <= today) ||
        (item.isTop3 && item.top3Locked) ||
        lockedIds.includes(item.id);
      const density = bufferedMinutes > 0
        ? (scores.priority_score || 0) / bufferedMinutes * (1 + 10 / bufferedMinutes)
        : (scores.priority_score || 0);
      return { ...item, ...scores, bufferedMinutes, isUrgent, badges, isProtected, density };
    }));

    const protectedTasks = scored.filter(i => i.isProtected);
    const flexible = scored.filter(i => !i.isProtected);
    flexible.sort((a, b) => b.density - a.density);

    const keep = [], overflow = [];
    let usedMinutes = 0;

    for (const item of protectedTasks) {
      keep.push({ ...item, reason: null });
      usedMinutes += item.bufferedMinutes;
    }

    for (const item of flexible) {
      if (usedMinutes + item.bufferedMinutes <= capacity) {
        keep.push({ ...item, reason: null });
        usedMinutes += item.bufferedMinutes;
      } else {
        let reason = defaultReason;
        if (item.density < 0.15) reason = 'low impact per minute';
        else if (item.bufferedMinutes > capacity * 0.7) reason = 'too long for remaining time';
        overflow.push({ ...item, reason });
      }
    }

    const protectedMinutes = protectedTasks.reduce((s, i) => s + i.bufferedMinutes, 0);
    return { keep, overflow, unrated, protectedOverflow: protectedMinutes > capacity };
  }

  async rerackAfterCompletion(completedItemId, lockedIds = []) {
    const allItems = await this.getAllItems();
    const usableCapacity = await this.getUsableCapacity();
    const today = this.getToday();

    const completedItem = await this.getItem(completedItemId);
    const actualBucket = completedItem?.actual_bucket || completedItem?.estimate_bucket || 0;
    const estimateBucket = completedItem?.estimate_bucket || 0;
    const overrunMinutes = Math.max(0, actualBucket - estimateBucket);
    const consumedMinutes = this._getDoneTodayConsumed(allItems, today);
    const remainingCapacity = Math.max(0, usableCapacity - consumedMinutes);

    const core = await this._rerackCore({
      excludeId: completedItemId, lockedIds,
      capacity: remainingCapacity,
      defaultReason: 'doesn\'t fit remaining time'
    });

    return {
      ...core, overrunMinutes, remainingCapacity,
      usableCapacity, consumedMinutes,
      completedItem: completedItem ? {
        text: completedItem.text,
        estimate_bucket: estimateBucket,
        actual_bucket: actualBucket
      } : null
    };
  }

  async rerackForTimePressure(lockedIds = []) {
    const allItems = await this.getAllItems();
    const usableCapacity = await this.getUsableCapacity();
    const today = this.getToday();
    const remainingDayMinutes = await this.getRemainingDayMinutes();

    const consumedMinutes = this._getDoneTodayConsumed(allItems, today);
    const budgetCapacity = Math.max(0, usableCapacity - consumedMinutes);
    const effectiveCapacity = Math.min(budgetCapacity, remainingDayMinutes);

    const core = await this._rerackCore({
      lockedIds, capacity: effectiveCapacity,
      defaultReason: 'not enough time left today'
    });

    return {
      ...core, overrunMinutes: 0,
      remainingCapacity: effectiveCapacity,
      usableCapacity, consumedMinutes,
      completedItem: null
    };
  }

  // ==================== CAPACITY ====================

  async getDailyCapacityOverride() {
    const override = await this.getSetting('daily_capacity_override', null);
    if (!override || override.date !== this.getToday()) return null;
    return override.minutes;
  }

  async setDailyCapacityOverride(minutes) {
    if (minutes === null) {
      await this.setSetting('daily_capacity_override', null);
    } else {
      await this.setSetting('daily_capacity_override', {
        date: this.getToday(),
        minutes: Math.max(0, Math.round(minutes))
      });
    }
  }

  /** Get today's usable minutes. Pass false to ignore daily override (returns base capacity). */
  async getUsableCapacity(includeOverride = true) {
    if (includeOverride) {
      const override = await this.getDailyCapacityOverride();
      if (override !== null) return override;
    }
    const capacityKey = this.isWeekend() ? 'weekend_capacity_minutes' : 'weekday_capacity_minutes';
    const capacity = await this.getSetting(capacityKey, DEFAULT_SETTINGS[capacityKey]);
    const slackPercent = await this.getSetting('always_plan_slack_percent', DEFAULT_SETTINGS.always_plan_slack_percent);
    return Math.round(capacity * (1 - slackPercent / 100));
  }

  async getDefaultUsableCapacity() {
    return this.getUsableCapacity(false);
  }

  async getRemainingDayMinutes() {
    const endHour = await this.getSetting('workday_end_hour', DEFAULT_SETTINGS.workday_end_hour);
    const now = new Date();
    const endOfDay = new Date(now);
    endOfDay.setHours(endHour, 0, 0, 0);
    return Math.max(0, Math.round((endOfDay - now) / 60000));
  }

  async checkTimePressure() {
    const remainingDayMinutes = await this.getRemainingDayMinutes();
    const todayItems = await this.getTodayItems();
    const today = this.getToday();
    const allItems = await this.getAllItems();
    const consumedMinutes = this._getDoneTodayConsumed(allItems, today);

    let remainingTaskMinutes = 0;
    const remainingTasks = [];
    for (const item of todayItems) {
      if (item.status === 'done') continue;
      const buffered = await this.getBufferedMinutes(item);
      const minutes = buffered || item.estimate_bucket || 0;
      remainingTaskMinutes += minutes;
      remainingTasks.push({ ...item, bufferedMinutes: minutes });
    }

    const overflowMinutes = Math.max(0, remainingTaskMinutes - remainingDayMinutes);

    let pressure = 'none';
    if (remainingDayMinutes === 0 && remainingTaskMinutes > 0) {
      pressure = 'overdue';
    } else if (remainingDayMinutes > 0 && remainingTaskMinutes > remainingDayMinutes) {
      pressure = (remainingTaskMinutes / remainingDayMinutes) > 1.5 ? 'critical' : 'warning';
    }

    const scored = remainingTasks.map(item => {
      const ps = this.isRated(item) ? (this.calculateScores(item).priority_score || 0) : 0;
      return { ...item, priority_score: ps };
    });
    scored.sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0));

    const overflowTasks = [];
    let filled = 0;
    for (const item of scored) {
      if (filled + item.bufferedMinutes <= remainingDayMinutes) {
        filled += item.bufferedMinutes;
      } else {
        overflowTasks.push(item);
      }
    }

    return { pressure, remainingDayMinutes, remainingTaskMinutes, consumedMinutes, overflowMinutes, overflowTasks };
  }

  // ==================== TODAY LOGIC ====================

  async getTodayItems() {
    const items = await this.getAllItems();
    const today = this.getToday();
    return items.filter(i => {
      if (i.parent_id || i.status === 'done') return false;
      if (i.status === 'today') return true;
      if (i.scheduled_for_date && i.scheduled_for_date <= today) return true;
      return false;
    });
  }

  isOverdue(item) {
    if (item.status === 'done' || !item.scheduled_for_date) return false;
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

  async suggestTop3() {
    const today = this.getToday();
    const todayItems = await this.getTodayItems();
    const usableCapacity = await this.getUsableCapacity();

    const lockedTop3 = todayItems.filter(i =>
      i.isTop3 && i.top3Date === today && i.top3Locked && this.isRated(i)
    );

    const candidates = todayItems.filter(i =>
      this.isRated(i) &&
      !(i.isTop3 && i.top3Date === today && i.top3Locked)
    );

    const scored = await Promise.all(candidates.map(async item => {
      const scores = this.calculateScores(item);
      const bufferedMinutes = await this.getBufferedMinutes(item);
      const isUrgent = item.C === 5;
      const isMonster = await this.isMonsterAsync(item);
      return { ...item, ...scores, bufferedMinutes, isUrgent, isMonster };
    }));

    this._sortByUrgencyAndScore(scored);

    let usedMinutes = 0, monsterCount = 0;
    const selected = [];

    for (const item of lockedTop3) {
      const buffered = await this.getBufferedMinutes(item);
      usedMinutes += buffered || 0;
      if (await this.isMonsterAsync(item)) monsterCount++;
      selected.push({ ...item, bufferedMinutes: buffered });
    }

    for (const item of scored) {
      if (selected.length >= 3) break;
      if (selected.find(s => s.id === item.id)) continue;
      if (item.isMonster && monsterCount >= 1) continue;
      if (usedMinutes + item.bufferedMinutes <= usableCapacity) {
        selected.push(item);
        usedMinutes += item.bufferedMinutes;
        if (item.isMonster) monsterCount++;
      }
    }

    let message = null;
    if (selected.length === 0 && scored.length > 0) {
      message = scored.every(s => s.isMonster)
        ? 'Everything is a MONSTER. Break a task down or lower estimates.'
        : 'No tasks fit within capacity. Reduce estimates or increase capacity.';
    } else if (selected.length < 3 && scored.length >= 3) {
      message = `Only ${selected.length} task${selected.length === 1 ? '' : 's'} fit within today's capacity. Break down a MONSTER or lower estimates.`;
    }

    return { suggested: selected, usedMinutes, usableCapacity, message, monsterCount, lockedCount: lockedTop3.length };
  }

  async applyTop3Suggestion(suggestion) {
    const today = this.getToday();
    const allItems = await this.getAllItems();

    for (const item of allItems) {
      if (item.isTop3 && item.top3Date === today && !item.top3Locked) {
        await this.updateItem(item.id, BattlePlanDB.CLEAR_TOP3);
      }
    }

    let order = 0;
    for (const item of suggestion.suggested) {
      await this.updateItem(item.id, { isTop3: true, top3Order: order++, top3Date: today });
    }
    return suggestion;
  }

  async setTop3(id, isTop3, manualToggle = true) {
    await this.ready;
    const item = await this.getItem(id);
    const today = this.getToday();

    if (isTop3) {
      const currentTop3 = await this.getTop3Items();
      const isMonster = await this.isMonsterAsync(item);
      let currentMonsterCount = 0;
      for (const i of currentTop3) {
        if (await this.isMonsterAsync(i)) currentMonsterCount++;
      }

      if (isMonster && currentMonsterCount >= 1 && !currentTop3.find(i => i.id === id)) {
        return { error: 'MONSTER_LIMIT', message: 'Only 1 MONSTER allowed in Top 3. Break it down or remove the other MONSTER first.' };
      }
      if (currentTop3.length >= 3 && !currentTop3.find(i => i.id === id)) {
        return { error: 'TOP3_FULL', message: 'Top 3 is full. Remove an item first.' };
      }

      return this.updateItem(id, {
        isTop3: true, top3Order: currentTop3.length,
        top3Date: today, top3Locked: manualToggle
      });
    } else {
      return this.updateItem(id, BattlePlanDB.CLEAR_TOP3);
    }
  }

  async getTop3Stats() {
    const top3Items = await this.getTop3Items();
    const usableCapacity = await this.getUsableCapacity();
    let totalBuffered = 0, monsterCount = 0, lockedCount = 0;

    for (const item of top3Items) {
      const buffered = await this.getBufferedMinutes(item);
      totalBuffered += buffered || 0;
      if (this.isMonster(item)) monsterCount++;
      if (item.top3Locked) lockedCount++;
    }

    return {
      totalBuffered, usableCapacity, monsterCount, lockedCount,
      isOverCapacity: totalBuffered > usableCapacity,
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
    return items.filter(i => !i.parent_id && i.status !== 'done' && i.scheduled_for_date === tomorrow);
  }

  async getItemsByStatus(status) {
    const items = await this.getAllItems();
    return items.filter(i => !i.parent_id && i.status === status);
  }

  // ==================== STATS ====================

  async getTodayStats() {
    const items = await this.getAllItems();
    const todayItems = await this.getTodayItems();
    const ratedCount = todayItems.filter(i => this.isRated(i)).length;
    const overdueItems = items.filter(i => this.isOverdue(i));
    const top3Stats = await this.getTop3Stats();

    return {
      totalTasks: todayItems.length, ratedCount,
      unratedCount: todayItems.length - ratedCount,
      overdueCount: overdueItems.length,
      ...top3Stats
    };
  }

  // ==================== SCHEDULING ====================

  async setTomorrow(id) {
    const tomorrow = this.getTomorrow();
    return this.updateItem(id, {
      status: 'tomorrow', scheduled_for_date: tomorrow,
      ...BattlePlanDB.CLEAR_TOP3
    });
  }

  async setToday(id) {
    return this.updateItem(id, { status: 'today', scheduled_for_date: this.getToday() });
  }

  async deferToTomorrow(id) {
    return this.updateItem(id, {
      status: 'tomorrow', scheduled_for_date: null,
      ...BattlePlanDB.CLEAR_TOP3
    });
  }

  // ==================== ROLLOVER / DAILY MAINTENANCE ====================

  async runDailyMaintenance() {
    await this.ready;
    const today = this.getToday();
    const items = await this.getAllItems();
    const usableCapacity = await this.getUsableCapacity();
    const autoClearTop3 = await this.getSetting('top3_auto_clear_daily', true);

    let overdueCount = 0, rolledCount = 0, deferredCount = 0, clearedTop3Count = 0;
    const protectedMoves = [];
    const candidates = [];
    const protectedIds = new Set();

    for (const item of items) {
      if (item.status === 'done') continue;

      if (this.isOverdue(item)) overdueCount++;

      // Due within 7 days - ALWAYS move to today
      if (item.dueDate && item.status !== 'today') {
        const now = new Date(); now.setHours(0, 0, 0, 0);
        const due = new Date(item.dueDate + 'T00:00:00');
        if (Math.ceil((due - now) / (1000 * 60 * 60 * 24)) <= 7) {
          protectedMoves.push(item);
          protectedIds.add(item.id);
          continue;
        }
      }

      // Scheduled for today or earlier
      if (item.scheduled_for_date && item.scheduled_for_date <= today && item.status !== 'today') {
        if (!protectedIds.has(item.id)) {
          protectedMoves.push(item);
          protectedIds.add(item.id);
        }
        continue;
      }

      // Tomorrow items without scheduled_for_date = overflow candidates
      if (item.status === 'tomorrow' && !item.scheduled_for_date) {
        candidates.push(item);
      }

      // Clear stale Top 3
      if (autoClearTop3 && item.isTop3 && item.top3Date && item.top3Date !== today && !item.top3Locked) {
        await this.updateItem(item.id, BattlePlanDB.CLEAR_TOP3);
        clearedTop3Count++;
      }
    }

    // Phase 1: Move all protected items to today
    for (const item of protectedMoves) {
      await this.updateItem(item.id, { status: 'today', scheduled_for_date: today });
      rolledCount++;
    }

    // Phase 2: Capacity-aware rollover of candidates
    const todayItems = await this.getTodayItems();
    let usedMinutes = 0;
    for (const ti of todayItems) {
      if (ti.status !== 'done') {
        usedMinutes += (await this.getBufferedMinutes(ti)) || 0;
      }
    }
    let remainingCapacity = usableCapacity - usedMinutes;

    const scored = await Promise.all(candidates.map(async item => {
      const scores = this.isRated(item) ? this.calculateScores(item) : { priority_score: 0 };
      const buffered = (await this.getBufferedMinutes(item)) || 0;
      return { id: item.id, priority_score: scores.priority_score || 0, bufferedMinutes: buffered, rated: this.isRated(item) };
    }));
    scored.sort((a, b) => b.priority_score - a.priority_score);

    for (const item of scored) {
      if (item.bufferedMinutes === 0 || item.bufferedMinutes <= remainingCapacity) {
        await this.updateItem(item.id, { status: 'today', scheduled_for_date: today });
        remainingCapacity -= item.bufferedMinutes;
        rolledCount++;
      } else {
        deferredCount++;
      }
    }

    return { overdueCount, rolledCount, deferredCount, clearedTop3Count };
  }

  async runRollover() { return this.runDailyMaintenance(); }

  // ==================== TASK COMPLETION ====================

  async completeTask(id, actual_bucket = null, skipRecurrence = false) {
    const item = await this.getItem(id);
    if (!item) return null;

    const now = new Date();
    let finalActual = actual_bucket;
    let calibrate = !!actual_bucket;

    if (!finalActual && item.started_at) {
      const rawMinutes = Math.round((now - new Date(item.started_at)) / 60000);
      if (rawMinutes > 0 && rawMinutes <= 480) {
        finalActual = rawMinutes;
        calibrate = true;
      }
    }

    finalActual = finalActual || item.estimate_bucket || 0;

    if (calibrate && item.estimate_bucket && finalActual > 0) {
      await this.addCalibrationEntry(item.tag, item.estimate_bucket, finalActual);
    }

    if (item.recurrence && !skipRecurrence) {
      await this.createNextRecurringTask(item);
    }

    return this.updateItem(id, {
      status: 'done', actual_bucket: finalActual,
      completed_at: now.toISOString(), started_at: null,
      ...BattlePlanDB.CLEAR_TOP3
    });
  }

  async startWork(id) {
    return this.updateItem(id, { started_at: new Date().toISOString() });
  }

  // ==================== SCHEDULE DRIFT ====================

  async checkScheduleDrift() {
    const today = this.getToday();
    const allItems = await this.getAllItems();

    const doneToday = allItems.filter(i =>
      i.status === 'done' && i.completed_at && i.completed_at.startsWith(today)
    );
    if (doneToday.length === 0) return null;

    doneToday.sort((a, b) => new Date(a.completed_at) - new Date(b.completed_at));
    const elapsedMinutes = Math.round((new Date() - new Date(doneToday[0].completed_at)) / 60000);

    let completedEstimateMinutes = 0;
    for (const item of doneToday) {
      completedEstimateMinutes += item.estimate_bucket || 0;
    }

    const driftMinutes = elapsedMinutes - completedEstimateMinutes;
    const threshold = Math.max(15, completedEstimateMinutes * 0.25);

    return { drifting: driftMinutes > threshold, driftMinutes, elapsedMinutes, completedEstimateMinutes };
  }

  async archiveDoneTasks(olderThanDays = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
    const items = await this.getAllItems();
    const toArchive = items.filter(item =>
      item.status === 'done' && !item.archived && new Date(item.updated_at) < cutoffDate
    );
    let archived = 0;
    for (const item of toArchive) {
      await this.updateItem(item.id, { archived: true });
      archived++;
    }
    return archived;
  }

  async getDoneItems(includeArchived = false) {
    const items = await this.getAllItems();
    return items.filter(item => item.status === 'done' && (includeArchived || !item.archived));
  }

  async createNextRecurringTask(originalItem) {
    const nextDate = this.getNextRecurrenceDate(originalItem);
    const now = new Date().toISOString();
    const newItem = {
      id: this.generateId(),
      text: originalItem.text, status: 'next',
      tag: originalItem.tag, next_action: originalItem.next_action,
      A: originalItem.A, C: originalItem.C, E: originalItem.E,
      L: originalItem.L, M: originalItem.M, T: originalItem.T,
      estimate_bucket: originalItem.estimate_bucket, confidence: originalItem.confidence,
      actual_bucket: null,
      ...BattlePlanDB.CLEAR_TOP3,
      scheduled_for_date: nextDate, dueDate: null,
      recurrence: originalItem.recurrence, recurrence_day: originalItem.recurrence_day,
      waiting_on: null, notes: null, parent_id: null,
      created_at: now, updated_at: now
    };
    await this._req('items', 'readwrite', s => s.add(newItem));
    this.scheduleAutoBackup();
    return newItem;
  }

  getNextRecurrenceDate(item) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let nextDate = new Date(today);

    switch (item.recurrence) {
      case 'daily':
        nextDate.setDate(nextDate.getDate() + 1);
        break;
      case 'weekly': {
        const targetDay = item.recurrence_day || 0;
        let daysUntilNext = targetDay - today.getDay();
        if (daysUntilNext <= 0) daysUntilNext += 7;
        nextDate.setDate(nextDate.getDate() + daysUntilNext);
        break;
      }
      case 'monthly': {
        const targetDate = item.recurrence_day || today.getDate();
        nextDate.setDate(1);
        nextDate.setMonth(nextDate.getMonth() + 1);
        const daysInMonth = new Date(nextDate.getFullYear(), nextDate.getMonth() + 1, 0).getDate();
        nextDate.setDate(Math.min(targetDate, daysInMonth));
        break;
      }
      default:
        nextDate.setDate(nextDate.getDate() + 1);
    }

    return nextDate.toISOString().split('T')[0];
  }

  // ==================== PRESETS ====================

  getPresets() {
    return {
      'mission-critical': { name: 'Mission-critical now', A: 5, C: 5, E: 3, L: 1, M: 1, T: 1, estimate_bucket: 60, confidence: 'medium' },
      'money-maker': { name: 'Money-maker', A: 5, C: 4, E: 2, L: 1, M: 2, T: 1, estimate_bucket: 60, confidence: 'medium' },
      'admin-tax': { name: 'Admin tax', A: 3, C: 4, E: 4, L: 0, M: 1, T: 0, estimate_bucket: 90, confidence: 'low' },
      'quick-win': { name: 'Quick win', A: 2, C: 3, E: 1, L: 0, M: 2, T: 2, estimate_bucket: 15, confidence: 'high' },
      'waiting-on-others': { name: 'Waiting on others', A: 3, C: 3, E: 2, L: 0, M: 0, T: 2, estimate_bucket: 15, confidence: 'high', status: 'waiting' }
    };
  }

  async applyPreset(id, presetKey) {
    const preset = this.getPresets()[presetKey];
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
      return matchesText && (status === null || item.status === status);
    });
  }

  // ==================== ROUTINES ====================

  async addRoutine(name) {
    await this.ready;
    const routine = { id: this.generateId(), name: name.trim(), items: [], created: new Date().toISOString() };
    await this._req('routines', 'readwrite', s => s.add(routine));
    this.scheduleAutoBackup();
    return routine;
  }

  async getRoutine(id) {
    await this.ready;
    return this._req('routines', 'readonly', s => s.get(id));
  }

  async updateRoutine(id, updates) {
    await this.ready;
    const routine = await this.getRoutine(id);
    if (!routine) return null;
    const updated = { ...routine, ...updates };
    await this._req('routines', 'readwrite', s => s.put(updated));
    this.scheduleAutoBackup();
    return updated;
  }

  async deleteRoutine(id) {
    await this.ready;
    await this._req('routines', 'readwrite', s => s.delete(id));
    this.scheduleAutoBackup();
    return true;
  }

  async getAllRoutines() {
    await this.ready;
    const result = await this._req('routines', 'readonly', s => s.getAll());
    return result || [];
  }

  async runRoutine(id) {
    await this.ready;
    const routine = await this.getRoutine(id);
    if (!routine) return [];

    const today = this.getToday();
    const targetStatus = routine.target_status || 'today';
    const createdItems = [];

    for (const entry of routine.items) {
      const isTemplate = typeof entry === 'object' && entry !== null;
      const text = isTemplate ? entry.text : entry;
      const item = await this.addItem(text);

      const updates = {
        status: targetStatus,
        scheduled_for_date: targetStatus === 'today' ? today : null
      };

      if (isTemplate) {
        if (entry.tag) updates.tag = entry.tag;
        for (const f of ['A', 'C', 'E', 'L', 'M', 'T']) {
          if (entry[f] != null) updates[f] = entry[f];
        }
        if (entry.estimate_bucket) updates.estimate_bucket = entry.estimate_bucket;
        if (entry.confidence) updates.confidence = entry.confidence;
        if (entry.recurrence) {
          updates.recurrence = entry.recurrence;
          if (entry.recurrence_day != null) updates.recurrence_day = entry.recurrence_day;
        }
      }

      await this.updateItem(item.id, updates);

      if (isTemplate && Array.isArray(entry.subtasks)) {
        for (const subText of entry.subtasks) {
          if (typeof subText === 'string' && subText.trim()) {
            await this.addSubtask(item.id, subText.trim());
          }
        }
      }

      createdItems.push(item);
    }
    return createdItems;
  }

  itemToTemplate(item) {
    const template = { text: item.text };
    if (item.tag) template.tag = item.tag;
    for (const f of ['A', 'C', 'E', 'L', 'M', 'T']) {
      if (item[f] != null) template[f] = item[f];
    }
    if (item.estimate_bucket) template.estimate_bucket = item.estimate_bucket;
    if (item.confidence) template.confidence = item.confidence;
    if (item.recurrence) {
      template.recurrence = item.recurrence;
      if (item.recurrence_day != null) template.recurrence_day = item.recurrence_day;
    }
    return template;
  }

  // ==================== SETTINGS ====================

  async getSetting(key, defaultValue = null) {
    await this.ready;
    const result = await this._req('settings', 'readonly', s => s.get(key));
    return result?.value ?? defaultValue;
  }

  async setSetting(key, value) {
    await this.ready;
    await this._req('settings', 'readwrite', s => s.put({ key, value }));
    return value;
  }

  // ==================== EXPORT/IMPORT ====================

  async exportData() {
    await this.ready;
    const items = await this.getAllItems();
    const routines = await this.getAllRoutines();

    const settings = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      settings[key] = await this.getSetting(key, DEFAULT_SETTINGS[key]);
    }

    const calibrationHistory = await this._req('calibration_history', 'readonly', s => s.getAll()) || [];

    return { version: 4, exported: new Date().toISOString(), items, routines, settings, calibrationHistory };
  }

  // Whitelisted fields for import sanitization — prevents prototype pollution & XSS via imported JSON
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

  static ALLOWED_ROUTINE_FIELDS = new Set(['id', 'name', 'items', 'created', 'created_at', 'updated_at']);
  static ALLOWED_CALIBRATION_FIELDS = new Set(['id', 'tag', 'estimate_bucket', 'actual_bucket', 'completed_at']);
  static ALLOWED_SETTINGS_KEYS = new Set([
    'timerDefault', 'weekday_capacity_minutes', 'weekend_capacity_minutes',
    'always_plan_slack_percent', 'auto_roll_tomorrow_to_today', 'top3_auto_clear_daily',
    'workday_start_hour', 'workday_end_hour'
  ]);

  static VALID_STATUSES = ['inbox', 'today', 'tomorrow', 'next', 'waiting', 'someday', 'done'];
  static VALID_CONFIDENCES = ['high', 'medium', 'low', null];
  static VALID_RECURRENCES = ['', 'daily', 'weekly', 'monthly', null];
  static VALID_TAGS = ['Home', 'Army', 'Business', 'Other'];

  /** Strip unknown keys from an object — only keeps properties in the allowed Set */
  _filterFields(obj, allowedSet) {
    const result = {};
    for (const key of Object.keys(obj)) {
      if (allowedSet.has(key)) result[key] = obj[key];
    }
    return result;
  }

  sanitizeItem(item) {
    const sanitized = this._filterFields(item, BattlePlanDB.ALLOWED_ITEM_FIELDS);
    if (sanitized.id) sanitized.id = String(sanitized.id).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!sanitized.id) sanitized.id = this.generateId();
    if (sanitized.tag && !BattlePlanDB.VALID_TAGS.includes(sanitized.tag)) sanitized.tag = null;
    if (sanitized.text) sanitized.text = String(sanitized.text).replace(/<[^>]*>/g, '');
    return sanitized;
  }

  sanitizeRoutine(routine) {
    const sanitized = this._filterFields(routine, BattlePlanDB.ALLOWED_ROUTINE_FIELDS);
    if (sanitized.id) sanitized.id = String(sanitized.id).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!sanitized.id) sanitized.id = this.generateId();
    if (sanitized.name) sanitized.name = String(sanitized.name).replace(/<[^>]*>/g, '');
    if (Array.isArray(sanitized.items)) {
      sanitized.items = sanitized.items.map(i => String(i).replace(/<[^>]*>/g, ''));
    }
    return sanitized;
  }

  sanitizeCalibrationEntry(entry) {
    const sanitized = this._filterFields(entry, BattlePlanDB.ALLOWED_CALIBRATION_FIELDS);
    if (!sanitized.id || typeof sanitized.id !== 'string') sanitized.id = this.generateId();

    const estimate = parseInt(sanitized.estimate_bucket);
    if (isNaN(estimate) || estimate <= 0) return null;
    sanitized.estimate_bucket = estimate;

    const actual = parseInt(sanitized.actual_bucket);
    if (isNaN(actual) || actual <= 0) return null;
    sanitized.actual_bucket = actual;

    if (!sanitized.tag || !BattlePlanDB.VALID_TAGS.includes(sanitized.tag)) sanitized.tag = 'Other';
    if (!sanitized.completed_at || isNaN(Date.parse(sanitized.completed_at))) sanitized.completed_at = new Date().toISOString();

    return sanitized;
  }

  validateItemTypes(item) {
    if (item.status && !BattlePlanDB.VALID_STATUSES.includes(item.status)) item.status = 'inbox';
    if (item.confidence && !BattlePlanDB.VALID_CONFIDENCES.includes(item.confidence)) item.confidence = null;
    if (item.recurrence && !BattlePlanDB.VALID_RECURRENCES.includes(item.recurrence)) item.recurrence = null;

    for (const field of ['A', 'C', 'E']) {
      if (item[field] !== null && item[field] !== undefined) {
        const val = parseInt(item[field]);
        item[field] = (isNaN(val) || val < 1 || val > 5) ? null : val;
      }
    }
    for (const field of ['L', 'M', 'T']) {
      if (item[field] !== null && item[field] !== undefined) {
        const val = parseInt(item[field]);
        item[field] = (isNaN(val) || val < 0 || val > 2) ? null : val;
      }
    }
    if (item.estimate_bucket !== null && item.estimate_bucket !== undefined) {
      const val = parseInt(item.estimate_bucket);
      item.estimate_bucket = (isNaN(val) || val < 0) ? null : val;
    }
    if (item.recurrence_day !== null && item.recurrence_day !== undefined) {
      const val = parseInt(item.recurrence_day);
      item.recurrence_day = (isNaN(val) || val < 0 || val > 31) ? null : val;
    }
    item.isTop3 = !!item.isTop3;
    item.top3Locked = !!item.top3Locked;
    item.archived = !!item.archived;
    return item;
  }

  async importData(data, skipConfirm = false) {
    await this.ready;
    if (!data || !data.version) throw new Error('Invalid backup file format');
    if (data.version > 4) throw new Error(`Backup version ${data.version} is newer than supported. Please update the app.`);

    // Clear all stores
    for (const store of ['items', 'routines', 'settings', 'calibration_history']) {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction(store, 'readwrite');
        const r = tx.objectStore(store).clear();
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      });
    }

    // Import items
    if (data.items && data.items.length > 0) {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction('items', 'readwrite');
        const store = tx.objectStore('items');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);

        const seenIds = new Set();
        for (const item of data.items) {
          const sanitized = this.sanitizeItem(item);
          if (seenIds.has(sanitized.id)) sanitized.id = this.generateId();
          seenIds.add(sanitized.id);

          const itemWithDefaults = {
            A: null, C: null, E: null, L: null, M: null, T: null,
            estimate_bucket: null, confidence: null, actual_bucket: null,
            next_action: null, scheduled_for_date: null,
            top3Date: null, top3Locked: false, archived: false,
            created_at: sanitized.created || new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...sanitized
          };
          this.validateItemTypes(itemWithDefaults);
          store.put(itemWithDefaults);
        }
      });
    }

    // Import routines
    if (data.routines && data.routines.length > 0) {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction('routines', 'readwrite');
        const store = tx.objectStore('routines');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);

        const seenIds = new Set();
        for (const routine of data.routines) {
          const sanitized = this.sanitizeRoutine(routine);
          if (seenIds.has(sanitized.id)) sanitized.id = this.generateId();
          seenIds.add(sanitized.id);

          if (sanitized.items && Array.isArray(sanitized.items)) {
            sanitized.items = sanitized.items.filter(item =>
              typeof item === 'string' || (typeof item === 'object' && item !== null && typeof item.text === 'string')
            ).slice(0, 100);
          } else {
            sanitized.items = [];
          }
          if (typeof sanitized.name !== 'string') sanitized.name = 'Imported Routine';
          store.put(sanitized);
        }
      });
    }

    // Import settings
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

    // Import calibration history
    if (data.calibrationHistory && data.calibrationHistory.length > 0) {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction('calibration_history', 'readwrite');
        const store = tx.objectStore('calibration_history');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);

        const seenIds = new Set();
        for (const entry of data.calibrationHistory) {
          const sanitized = this.sanitizeCalibrationEntry(entry);
          if (!sanitized) continue;
          if (seenIds.has(sanitized.id)) sanitized.id = this.generateId();
          seenIds.add(sanitized.id);
          store.put(sanitized);
        }
      });
    }

    return true;
  }

  // ==================== DIAGNOSTICS ====================

  async runDiagnostics() {
    const today = this.getToday();
    const allItems = await this.getAllItems();
    const todayItems = await this.getTodayItems();
    const top3Items = await this.getTop3Items();
    const usableCapacity = await this.getUsableCapacity();

    const ratedItems = todayItems.filter(i => this.isRated(i));
    const unratedItems = todayItems.filter(i => !this.isRated(i));
    const overdueItems = allItems.filter(i => this.isOverdue(i));
    const monsterItems = todayItems.filter(i => this.isMonster(i));

    let top3BufferedTotal = 0;
    for (const item of top3Items) {
      top3BufferedTotal += (await this.getBufferedMinutes(item)) || 0;
    }

    const mapped = ratedItems.map(item => ({
      text: item.text.substring(0, 30),
      score: this.calculateScores(item).priority_score,
      isMonster: this.isMonster(item),
      isUrgent: item.C === 5
    }));
    this._sortByUrgencyAndScore(mapped, 'score');
    const sorted = mapped.slice(0, 5);

    return {
      date: today, totalItems: allItems.length,
      todayCount: todayItems.length, ratedCount: ratedItems.length,
      unratedCount: unratedItems.length, overdueCount: overdueItems.length,
      monsterCount: monsterItems.length, top3Count: top3Items.length,
      top3BufferedTotal, usableCapacity,
      capacityUsedPercent: Math.round((top3BufferedTotal / usableCapacity) * 100),
      sampleSortOrder: sorted
    };
  }

  // ==================== AUTO-BACKUP ====================

  scheduleAutoBackup() {
    if (this.autoBackupTimeout) clearTimeout(this.autoBackupTimeout);
    this.autoBackupTimeout = setTimeout(() => this.performAutoBackup(), 5000);
  }

  async performAutoBackup() {
    try {
      await this.ready;
      const data = await this.exportData();
      const backups = await this.getAutoBackups();
      backups.unshift({ timestamp: new Date().toISOString(), data });
      while (backups.length > 3) backups.pop();
      await this.setSetting('_autoBackups', backups);
    } catch (e) {
      // Silently fail - auto-backup is non-critical
    }
  }

  async getAutoBackups() {
    await this.ready;
    const idbBackups = await this.getSetting('_autoBackups', null);
    if (idbBackups) return idbBackups;
    const lsBackups = localStorage.getItem('battlePlanAutoBackups');
    if (lsBackups) {
      const parsed = JSON.parse(lsBackups);
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

const BUCKETS = ESTIMATE_BUCKETS;
const db = new BattlePlanDB();
