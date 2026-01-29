/**
 * Battle Plan - IndexedDB Storage Layer
 * Handles all data persistence with local-first approach
 */

const DB_NAME = 'BattlePlanDB';
const DB_VERSION = 1;

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

        // Items store - main task items
        if (!db.objectStoreNames.contains('items')) {
          const itemStore = db.createObjectStore('items', { keyPath: 'id' });
          itemStore.createIndex('status', 'status', { unique: false });
          itemStore.createIndex('created', 'created', { unique: false });
          itemStore.createIndex('isTop3', 'isTop3', { unique: false });
        }

        // Routines store - reusable checklists
        if (!db.objectStoreNames.contains('routines')) {
          db.createObjectStore('routines', { keyPath: 'id' });
        }

        // Settings store
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
    });
  }

  // Generate unique ID
  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  // ==================== ITEMS ====================

  async addItem(text) {
    await this.ready;
    const item = {
      id: this.generateId(),
      text: text.trim(),
      status: 'inbox',
      created: new Date().toISOString(),
      dueDate: null,
      estimate: null,
      tag: null,
      isTop3: false,
      top3Order: null
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

    const updated = { ...item, ...updates };

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

  async getItemsByStatus(status) {
    await this.ready;
    const allItems = await this.getAllItems();
    return allItems.filter(item => item.status === status);
  }

  async getTodayItems() {
    await this.ready;
    const allItems = await this.getAllItems();
    return allItems.filter(item => item.status === 'today' && item.status !== 'done');
  }

  async getTop3Items() {
    await this.ready;
    const allItems = await this.getAllItems();
    return allItems
      .filter(item => item.isTop3 && item.status !== 'done')
      .sort((a, b) => (a.top3Order || 0) - (b.top3Order || 0));
  }

  async setTop3(id, isTop3, order = null) {
    await this.ready;
    if (isTop3) {
      const currentTop3 = await this.getTop3Items();
      if (currentTop3.length >= 3 && !currentTop3.find(i => i.id === id)) {
        return { error: 'Top 3 is full. Remove an item first.' };
      }
      order = order ?? currentTop3.length;
    }
    return this.updateItem(id, { isTop3, top3Order: isTop3 ? order : null });
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
    const timerDefault = await this.getSetting('timerDefault', 25);

    return {
      version: 1,
      exported: new Date().toISOString(),
      items,
      routines,
      settings: { timerDefault }
    };
  }

  async importData(data) {
    await this.ready;
    if (!data || data.version !== 1) {
      throw new Error('Invalid backup file format');
    }

    // Clear existing data
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

    // Import items
    for (const item of (data.items || [])) {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction('items', 'readwrite');
        const store = tx.objectStore('items');
        const request = store.add(item);
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
    if (data.settings?.timerDefault) {
      await this.setSetting('timerDefault', data.settings.timerDefault);
    }

    return true;
  }
}

// Global database instance
const db = new BattlePlanDB();
