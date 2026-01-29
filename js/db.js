/**
 * Battle Plan - IndexedDB Storage Layer
 * Army-style prioritization with ACE+LMT scoring
 */

const DB_NAME = 'BattlePlanDB';
const DB_VERSION = 3;

// Constants
const ESTIMATE_BUCKETS = [15, 30, 60, 90, 120, 180];
const CONFIDENCE_MULTIPLIERS = { high: 1.1, medium: 1.3, low: 1.6 };
const DEFAULT_SETTINGS = {
  timerDefault: 25,
  weekday_capacity_minutes: 180,
  weekend_capacity_minutes: 360,
  always_plan_slack_percent: 30
};

class BattlePlanDB {
  constructor() {
    this.db = null;
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

        if (!db.objectStoreNames.contains('items')) {
          const itemStore = db.createObjectStore('items', { keyPath: 'id' });
          itemStore.createIndex('status', 'status', { unique: false });
          itemStore.createIndex('created_at', 'created_at', { unique: false });
          itemStore.createIndex('isTop3', 'isTop3', { unique: false });
          itemStore.createIndex('tag', 'tag', { unique: false });
        }

        if (!db.objectStoreNames.contains('routines')) {
          db.createObjectStore('routines', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }

        // Calibration history store
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
      A: null, // actual_impact 1-5
      C: null, // consequences 1-5
      E: null, // enemy_friction 1-5
      // LMT bonuses
      L: null, // leverage 0-2
      M: null, // energy_match 0-2
      T: null, // time_reality 0-2
      // Time planning
      estimate_bucket: null,
      confidence: null,
      actual_bucket: null,
      // Top 3
      isTop3: false,
      top3Order: null,
      // Scheduling
      scheduled_for_date: null,
      dueDate: null,
      // Timestamps
      created_at: now,
      updated_at: now
    };

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readwrite');
      const store = tx.objectStore('items');
      const request = store.add(item);
      request.onsuccess = () => resolve(item);
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
      request.onsuccess = () => resolve(updated);
      request.onerror = () => reject(request.error);
    });
  }

  async deleteItem(id) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readwrite');
      const store = tx.objectStore('items');
      const request = store.delete(id);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }

  async getAllItems() {
    await this.ready;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readonly');
      const store = tx.objectStore('items');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
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
    if (item.estimate_bucket >= 90 || item.confidence === 'low') badges.push('MONSTER');
    if (item.L === 2) badges.push('LEVERAGE');
    if (item.E >= 4) badges.push('FRICTION');

    return badges;
  }

  isRated(item) {
    return item.A != null && item.C != null && item.E != null &&
           item.L != null && item.M != null && item.T != null &&
           item.estimate_bucket != null && item.confidence != null;
  }

  isMonster(item) {
    return item.estimate_bucket >= 90 || item.confidence === 'low';
  }

  // ==================== TIME PLANNING ====================

  async getCalibrationFactor(tag) {
    await this.ready;
    const history = await this.getCalibrationHistory(tag || 'Other');

    if (history.length === 0) return 1.0;

    const ratios = history.map(h => h.actual_bucket / h.estimate_bucket);
    const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;

    // Bound to [1.0, 2.0]
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
    const buffered = item.estimate_bucket * multiplier;
    const calibrationFactor = await this.getCalibrationFactor(item.tag);

    return Math.round(buffered * calibrationFactor);
  }

  // ==================== CAPACITY ====================

  async getUsableCapacity() {
    const isWeekend = this.isWeekend();
    const capacityKey = isWeekend ? 'weekend_capacity_minutes' : 'weekday_capacity_minutes';
    const capacity = await this.getSetting(capacityKey, DEFAULT_SETTINGS[capacityKey]);
    const slackPercent = await this.getSetting('always_plan_slack_percent', DEFAULT_SETTINGS.always_plan_slack_percent);

    return Math.round(capacity * (1 - slackPercent / 100));
  }

  // ==================== TOP 3 SELECTION ====================

  async getTodayItems() {
    const items = await this.getAllItems();
    const today = this.getToday();
    return items.filter(i =>
      i.status !== 'done' && (
        i.status === 'today' ||
        i.scheduled_for_date === today ||
        (i.scheduled_for_date && i.scheduled_for_date < today)
      )
    );
  }

  async getTop3Items() {
    const items = await this.getAllItems();
    return items
      .filter(i => i.isTop3 && i.status !== 'done')
      .sort((a, b) => (a.top3Order || 0) - (b.top3Order || 0));
  }

  async suggestTop3() {
    const todayItems = await this.getTodayItems();
    const usableCapacity = await this.getUsableCapacity();

    // Filter to only rated tasks
    const ratedItems = todayItems.filter(i => this.isRated(i) && i.status !== 'done');

    // Calculate scores and sort
    const scored = await Promise.all(ratedItems.map(async item => {
      const scores = this.calculateScores(item);
      const bufferedMinutes = await this.getBufferedMinutes(item);
      const isUrgent = item.C === 5;
      const isMonster = this.isMonster(item);
      return { ...item, ...scores, bufferedMinutes, isUrgent, isMonster };
    }));

    // Sort: URGENT first, then by priority_score descending
    scored.sort((a, b) => {
      if (a.isUrgent && !b.isUrgent) return -1;
      if (!a.isUrgent && b.isUrgent) return 1;
      return (b.priority_score || 0) - (a.priority_score || 0);
    });

    // Greedy selection
    const selected = [];
    let usedMinutes = 0;
    let monsterCount = 0;

    for (const item of scored) {
      if (selected.length >= 3) break;

      // Monster rule: max 1 MONSTER
      if (item.isMonster) {
        if (monsterCount >= 1) continue;
        monsterCount++;
      }

      // Capacity check
      if (usedMinutes + item.bufferedMinutes <= usableCapacity) {
        selected.push(item);
        usedMinutes += item.bufferedMinutes;
      }
    }

    const message = selected.length < 3
      ? `Only ${selected.length} task${selected.length === 1 ? '' : 's'} fit within today's capacity. Break down a MONSTER or lower estimates.`
      : null;

    return {
      suggested: selected,
      usedMinutes,
      usableCapacity,
      message,
      monsterCount
    };
  }

  async applyTop3Suggestion(suggestion) {
    // Clear all current Top 3
    const allItems = await this.getAllItems();
    for (const item of allItems) {
      if (item.isTop3) {
        await this.updateItem(item.id, { isTop3: false, top3Order: null });
      }
    }

    // Set new Top 3
    for (let i = 0; i < suggestion.suggested.length; i++) {
      await this.updateItem(suggestion.suggested[i].id, {
        isTop3: true,
        top3Order: i
      });
    }

    return suggestion;
  }

  async setTop3(id, isTop3, order = null) {
    await this.ready;
    const item = await this.getItem(id);

    if (isTop3) {
      const currentTop3 = await this.getTop3Items();
      const usableCapacity = await this.getUsableCapacity();

      // Check monster rule
      const isMonster = this.isMonster(item);
      const currentMonsterCount = currentTop3.filter(i => this.isMonster(i)).length;

      if (isMonster && currentMonsterCount >= 1 && !currentTop3.find(i => i.id === id)) {
        return {
          error: 'MONSTER_LIMIT',
          message: 'Break it down into smaller steps (subtasks) or lower the estimate bucket.'
        };
      }

      // Check count limit
      if (currentTop3.length >= 3 && !currentTop3.find(i => i.id === id)) {
        return { error: 'Top 3 is full. Remove an item first.' };
      }

      order = order ?? currentTop3.length;
    }

    return this.updateItem(id, { isTop3, top3Order: isTop3 ? order : null });
  }

  async getTop3Stats() {
    const top3Items = await this.getTop3Items();
    const usableCapacity = await this.getUsableCapacity();

    let totalBuffered = 0;
    let monsterCount = 0;

    for (const item of top3Items) {
      const buffered = await this.getBufferedMinutes(item);
      totalBuffered += buffered || 0;
      if (this.isMonster(item)) monsterCount++;
    }

    const isOverCapacity = totalBuffered > usableCapacity;

    return {
      totalBuffered,
      usableCapacity,
      monsterCount,
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
      i.status !== 'done' && i.scheduled_for_date === tomorrow
    );
  }

  async getItemsByStatus(status) {
    const items = await this.getAllItems();
    return items.filter(i => i.status === status);
  }

  isOverdue(item) {
    if (!item.scheduled_for_date || item.status === 'done') return false;
    return item.scheduled_for_date < this.getToday();
  }

  // ==================== STATS ====================

  async getTodayStats() {
    const items = await this.getAllItems();
    const today = this.getToday();

    const todayItems = items.filter(i =>
      i.status !== 'done' && (
        i.status === 'today' ||
        i.scheduled_for_date === today ||
        (i.scheduled_for_date && i.scheduled_for_date < today)
      )
    );

    const ratedCount = todayItems.filter(i => this.isRated(i)).length;
    const unratedCount = todayItems.length - ratedCount;

    const overdueItems = items.filter(i =>
      i.status !== 'done' &&
      i.scheduled_for_date &&
      i.scheduled_for_date < today
    );

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
      scheduled_for_date: tomorrow
    });
  }

  async setToday(id) {
    return this.updateItem(id, {
      status: 'today',
      scheduled_for_date: null
    });
  }

  async runRollover() {
    await this.ready;
    const items = await this.getAllItems();
    const today = this.getToday();
    let overdueCount = 0;

    for (const item of items) {
      if (item.scheduled_for_date &&
          item.scheduled_for_date < today &&
          item.status !== 'done') {
        overdueCount++;
      }
    }

    return { overdueCount };
  }

  // ==================== TASK COMPLETION ====================

  async completeTask(id, actual_bucket) {
    const item = await this.getItem(id);
    if (!item) return null;

    // Record calibration if we have both buckets
    if (item.estimate_bucket && actual_bucket) {
      await this.addCalibrationEntry(item.tag, item.estimate_bucket, actual_bucket);
    }

    return this.updateItem(id, {
      status: 'done',
      actual_bucket,
      isTop3: false,
      top3Order: null
    });
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
      request.onsuccess = () => resolve(routine);
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
      request.onsuccess = () => resolve(updated);
      request.onerror = () => reject(request.error);
    });
  }

  async deleteRoutine(id) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('routines', 'readwrite');
      const store = tx.objectStore('routines');
      const request = store.delete(id);
      request.onsuccess = () => resolve(true);
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

    const createdItems = [];
    for (const itemText of routine.items) {
      const item = await this.addItem(itemText);
      await this.updateItem(item.id, { status: 'today' });
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
      version: 3,
      exported: new Date().toISOString(),
      items,
      routines,
      settings,
      calibrationHistory
    };
  }

  async importData(data) {
    await this.ready;
    if (!data || !data.version) {
      throw new Error('Invalid backup file format');
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

    // Import items with defaults for new fields
    for (const item of (data.items || [])) {
      const itemWithDefaults = {
        A: null, C: null, E: null, L: null, M: null, T: null,
        estimate_bucket: null, confidence: null, actual_bucket: null,
        next_action: null,
        scheduled_for_date: null,
        created_at: item.created || new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...item
      };
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction('items', 'readwrite');
        const store = tx.objectStore('items');
        const request = store.add(itemWithDefaults);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }

    // Import routines
    for (const routine of (data.routines || [])) {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction('routines', 'readwrite');
        const store = tx.objectStore('routines');
        const request = store.add(routine);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }

    // Import settings
    if (data.settings) {
      for (const [key, value] of Object.entries(data.settings)) {
        await this.setSetting(key, value);
      }
    }

    // Import calibration history
    for (const entry of (data.calibrationHistory || [])) {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction('calibration_history', 'readwrite');
        const store = tx.objectStore('calibration_history');
        const request = store.add(entry);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }

    return true;
  }
}

// Constants export
const BUCKETS = ESTIMATE_BUCKETS;
const CONFIDENCE_LEVELS = ['high', 'medium', 'low'];

// Global database instance
const db = new BattlePlanDB();
