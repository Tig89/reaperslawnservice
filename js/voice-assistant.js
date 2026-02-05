/**
 * Battle Plan - AI Voice Assistant
 * LLM-powered voice control using Groq API
 */

class VoiceAssistant {
  constructor(app) {
    this.app = app;
    this.apiKey = localStorage.getItem('groqApiKey') || '';
    this.apiEndpoint = 'https://api.groq.com/openai/v1/chat/completions';
    this.model = 'llama-3.1-8b-instant';

    // Speech recognition
    this.recognition = null;
    this.isListening = false;
    this.voiceSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

    // Speech synthesis
    this.synthesis = window.speechSynthesis;
    this.isSpeaking = false;

    // State
    this.isProcessing = false;
    this.conversationHistory = [];
    this.maxHistoryLength = 4; // Keep last 4 exchanges for context

    // Offline mode
    this.cachedRecommendation = localStorage.getItem('aiLastRecommendation') || null;

    this.init();
  }

  // Check if we can use AI (online + has key)
  canUseAI() {
    return navigator.onLine && this.apiKey;
  }

  init() {
    if (!this.voiceSupported) {
      console.log('Voice not supported in this browser');
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRecognition();
    this.recognition.continuous = false;
    this.recognition.interimResults = false;
    this.recognition.lang = 'en-US';

    this.recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      this.handleVoiceInput(transcript);
    };

    this.recognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      this.stopListening();
      if (event.error === 'not-allowed') {
        this.showResponse('Microphone access denied. Please allow microphone access.');
      } else if (event.error !== 'aborted') {
        this.showResponse('Voice input error. Please try again.');
      }
    };

    this.recognition.onend = () => {
      this.stopListening();
    };

    this.createUI();
    this.bindEvents();
  }

  createUI() {
    // Create floating assistant button
    const assistantBtn = document.createElement('button');
    assistantBtn.id = 'ai-assistant-btn';
    assistantBtn.className = 'ai-assistant-btn';
    assistantBtn.setAttribute('aria-label', 'AI Voice Assistant');
    assistantBtn.innerHTML = '<span class="ai-icon">AI</span>';
    document.body.appendChild(assistantBtn);

    // Create response panel
    const panel = document.createElement('div');
    panel.id = 'ai-assistant-panel';
    panel.className = 'ai-assistant-panel hidden';
    panel.innerHTML = `
      <div class="ai-panel-header">
        <span class="ai-title">AI Assistant</span>
        <span id="ai-mode-badge" class="ai-mode-badge ${this.canUseAI() ? 'online' : 'offline'}">${this.canUseAI() ? 'AI' : 'Offline'}</span>
        <button class="ai-close-btn" aria-label="Close">&times;</button>
      </div>
      <div class="ai-panel-content">
        <div id="ai-response" class="ai-response">
          ${this.getHelpContent()}
        </div>
      </div>
      <div class="ai-panel-actions">
        <button id="ai-mic-btn" class="ai-mic-btn" aria-label="Start voice input">
          <span class="mic-icon">🎤</span>
          <span class="mic-text">Tap to speak</span>
        </button>
        <button id="ai-stop-speech-btn" class="ai-stop-speech-btn hidden" aria-label="Stop speaking">
          Stop
        </button>
      </div>
    `;
    document.body.appendChild(panel);

    // Listen for online/offline changes
    window.addEventListener('online', () => this.updateModeIndicator());
    window.addEventListener('offline', () => this.updateModeIndicator());
  }

  updateModeIndicator() {
    const badge = document.getElementById('ai-mode-badge');
    if (badge) {
      const canAI = this.canUseAI();
      badge.textContent = canAI ? 'AI' : 'Offline';
      badge.className = `ai-mode-badge ${canAI ? 'online' : 'offline'}`;
    }
  }

  getHelpContent() {
    const offlineCommands = `
      <p class="ai-hint"><strong>Voice Commands</strong> (work offline):</p>
      <ul class="ai-examples">
        <li>"Add task buy groceries"</li>
        <li>"Complete the phone call task"</li>
        <li>"Move laundry to tomorrow"</li>
        <li>"Delete the old task"</li>
        <li>"Go to today" / "Show inbox"</li>
        <li>"Start focus mode"</li>
        <li>"What's next?" (uses cached suggestion)</li>
      </ul>
    `;

    const aiQueries = this.apiKey ? `
      <p class="ai-hint"><strong>AI Queries</strong> (requires internet):</p>
      <ul class="ai-examples">
        <li>"Why is this task ranked first?"</li>
        <li>"I have 30 minutes, what can I do?"</li>
        <li>"What's blocking my progress?"</li>
        <li>"Summarize my waiting list"</li>
      </ul>
    ` : `
      <p class="ai-hint ai-setup-hint">Add a <a href="#" id="ai-setup-link">Groq API key</a> to unlock AI-powered questions and smart suggestions.</p>
    `;

    return offlineCommands + aiQueries;
  }

  getSetupContent() {
    return `
      <div class="ai-setup">
        <p class="ai-hint">To use the AI assistant, you need a free Groq API key:</p>
        <ol class="ai-setup-steps">
          <li>Go to <a href="https://console.groq.com" target="_blank" rel="noopener">console.groq.com</a></li>
          <li>Sign up for a free account</li>
          <li>Create an API key</li>
          <li>Paste it below:</li>
        </ol>
        <div class="ai-key-input-wrapper">
          <input type="password" id="ai-api-key-input" class="ai-key-input" placeholder="gsk_..." autocomplete="off">
          <button id="ai-save-key-btn" class="ai-save-key-btn">Save</button>
        </div>
        <p class="ai-key-hint">Your key is stored locally and never sent anywhere except Groq.</p>
      </div>
    `;
  }

  bindEvents() {
    // Toggle panel
    document.getElementById('ai-assistant-btn').addEventListener('click', () => {
      this.togglePanel();
    });

    // Close panel
    document.querySelector('.ai-close-btn').addEventListener('click', () => {
      this.closePanel();
    });

    // Mic button - always enabled (offline commands work without API key)
    document.getElementById('ai-mic-btn').addEventListener('click', () => {
      if (this.isListening) {
        this.stopListening();
      } else {
        this.startListening();
      }
    });

    // Stop speech button
    document.getElementById('ai-stop-speech-btn').addEventListener('click', () => {
      this.stopSpeaking();
    });

    // Setup link (shown when no API key)
    document.addEventListener('click', (e) => {
      if (e.target.id === 'ai-setup-link') {
        e.preventDefault();
        this.showResponse(this.getSetupContent());
      }
    });

    // Save API key button (delegated)
    document.addEventListener('click', (e) => {
      if (e.target.id === 'ai-save-key-btn') {
        this.saveApiKey();
      }
    });

    // Allow Enter to save key (delegated)
    document.addEventListener('keydown', (e) => {
      if (e.target.id === 'ai-api-key-input' && e.key === 'Enter') {
        this.saveApiKey();
      }
      // Close on escape
      if (e.key === 'Escape' && !document.getElementById('ai-assistant-panel').classList.contains('hidden')) {
        this.closePanel();
      }
    });
  }

  saveApiKey() {
    const input = document.getElementById('ai-api-key-input');
    const key = input?.value?.trim();

    if (!key) {
      this.showResponse('<span style="color: var(--danger);">Please enter an API key</span>');
      return;
    }

    if (!key.startsWith('gsk_')) {
      this.showResponse('<span style="color: var(--danger);">Invalid key format. Groq keys start with "gsk_"</span>');
      return;
    }

    // Save the key
    localStorage.setItem('groqApiKey', key);
    this.apiKey = key;

    // Update mode indicator
    this.updateModeIndicator();

    // Show updated help content
    this.showResponse(this.getHelpContent());
    this.app.showToast('API key saved! AI features unlocked.');
  }

  togglePanel() {
    const panel = document.getElementById('ai-assistant-panel');
    const btn = document.getElementById('ai-assistant-btn');

    if (panel.classList.contains('hidden')) {
      panel.classList.remove('hidden');
      btn.classList.add('active');
    } else {
      this.closePanel();
    }
  }

  closePanel() {
    const panel = document.getElementById('ai-assistant-panel');
    const btn = document.getElementById('ai-assistant-btn');

    panel.classList.add('hidden');
    btn.classList.remove('active');
    this.stopListening();
    this.stopSpeaking();
  }

  startListening() {
    if (!this.voiceSupported || this.isProcessing) return;

    this.isListening = true;
    const micBtn = document.getElementById('ai-mic-btn');
    micBtn.classList.add('listening');
    micBtn.querySelector('.mic-text').textContent = 'Listening...';

    try {
      this.recognition.start();
    } catch (err) {
      console.error('Failed to start recognition:', err);
      this.stopListening();
    }
  }

  stopListening() {
    this.isListening = false;
    const micBtn = document.getElementById('ai-mic-btn');
    if (micBtn) {
      micBtn.classList.remove('listening');
      micBtn.querySelector('.mic-text').textContent = 'Tap to speak';
    }

    try {
      this.recognition?.stop();
    } catch (err) {
      // Ignore
    }
  }

  async handleVoiceInput(transcript) {
    this.showResponse(`<em>You said: "${transcript}"</em><br><br>Processing...`);
    this.isProcessing = true;

    const micBtn = document.getElementById('ai-mic-btn');
    micBtn.classList.add('processing');
    micBtn.querySelector('.mic-text').textContent = 'Processing...';

    try {
      // Try offline command parsing first
      const offlineResult = await this.tryOfflineCommand(transcript);

      if (offlineResult.handled) {
        // Command was handled offline
        this.showResponse(offlineResult.response);
        this.speak(offlineResult.response);
      } else if (this.canUseAI()) {
        // Fall back to AI for complex queries
        this.showResponse(`<em>You said: "${transcript}"</em><br><br>Asking AI...`);
        const response = await this.processWithLLM(transcript);
        await this.handleLLMResponse(response, transcript);
      } else {
        // Offline and not a recognized command
        this.showResponse(`I didn't understand that command. Try saying:<br><br>
          • "Add task [description]"<br>
          • "Complete [task name]"<br>
          • "Move [task] to tomorrow"<br>
          • "Go to today"<br>
          • "Start focus"<br><br>
          <em>For smart questions, connect to internet and add an API key.</em>`);
        this.speak("I didn't understand that command. Try add task, complete, move to tomorrow, or go to today.");
      }
    } catch (error) {
      console.error('Voice processing error:', error);
      this.showResponse('Sorry, I had trouble processing that. Please try again.');
      this.speak('Sorry, I had trouble processing that.');
    } finally {
      this.isProcessing = false;
      micBtn.classList.remove('processing');
      micBtn.querySelector('.mic-text').textContent = 'Tap to speak';
    }
  }

  // Offline command parsing - works without internet
  async tryOfflineCommand(text) {
    const lower = text.toLowerCase().trim();

    // === ADD TASK ===
    // "add task X", "add X to inbox/today/tomorrow"
    let addMatch = lower.match(/^add\s+(?:task\s+)?(.+?)(?:\s+to\s+(inbox|today|tomorrow|next|someday))?$/i);
    if (addMatch) {
      const taskText = addMatch[1].trim();
      const destination = addMatch[2] || 'inbox';
      const item = await db.addItem(taskText);

      if (destination !== 'inbox') {
        if (destination === 'today') await db.setToday(item.id);
        else if (destination === 'tomorrow') await db.setTomorrow(item.id);
        else await db.updateItem(item.id, { status: destination });
      }

      await this.app.render();
      await this.app.updateHUD();
      return { handled: true, response: `Added "${taskText}" to ${destination}` };
    }

    // === COMPLETE TASK ===
    // "complete X", "mark X done", "finish X", "done with X"
    const doneMatch = lower.match(/^(?:complete|finish|mark\s+done|done\s+with|mark\s+.+\s+done)\s+(?:the\s+)?(.+?)(?:\s+task)?$/i);
    if (doneMatch) {
      const keyword = doneMatch[1].replace(/\s+task$/, '').trim();
      const item = await this.app.findItemByKeyword(keyword);
      if (item) {
        await this.app.setItemStatus(item.id, 'done');
        return { handled: true, response: `Completed: ${item.text}` };
      }
      return { handled: true, response: `Couldn't find a task matching "${keyword}"` };
    }

    // === MOVE TASK ===
    // "move X to tomorrow/today/next/waiting/someday"
    const moveMatch = lower.match(/^move\s+(?:the\s+)?(.+?)\s+to\s+(today|tomorrow|next|waiting|someday)$/i);
    if (moveMatch) {
      const keyword = moveMatch[1].replace(/\s+task$/, '').trim();
      const destination = moveMatch[2];
      const item = await this.app.findItemByKeyword(keyword);
      if (item) {
        if (destination === 'today') await db.setToday(item.id);
        else if (destination === 'tomorrow') await db.setTomorrow(item.id);
        else await db.updateItem(item.id, { status: destination });
        await this.app.render();
        await this.app.updateHUD();
        return { handled: true, response: `Moved "${item.text}" to ${destination}` };
      }
      return { handled: true, response: `Couldn't find a task matching "${keyword}"` };
    }

    // === DELETE TASK ===
    // "delete X", "remove X"
    const deleteMatch = lower.match(/^(?:delete|remove)\s+(?:the\s+)?(.+?)(?:\s+task)?$/i);
    if (deleteMatch) {
      const keyword = deleteMatch[1].trim();
      const item = await this.app.findItemByKeyword(keyword);
      if (item) {
        await this.app.saveDeleteForUndo(item.id, `Deleted: ${item.text}`);
        await db.deleteItem(item.id);
        await this.app.render();
        await this.app.updateHUD();
        return { handled: true, response: `Deleted: ${item.text}` };
      }
      return { handled: true, response: `Couldn't find a task matching "${keyword}"` };
    }

    // === NAVIGATION ===
    // "go to X", "show X", "open X"
    const navMatch = lower.match(/^(?:go\s+to|show|open)\s+(?:the\s+)?(inbox|today|tomorrow|next|waiting|someday|done|settings|stats|routines)$/i);
    if (navMatch) {
      const page = navMatch[1] === 'stats' ? 'analytics' : navMatch[1];
      this.app.navigateTo(page);
      return { handled: true, response: `Showing ${page}` };
    }

    // === FOCUS MODE ===
    if (lower.match(/^(?:start\s+)?focus(?:\s+mode)?$/i)) {
      this.app.startFocus();
      return { handled: true, response: 'Starting focus mode' };
    }

    // === SUGGEST TOP 3 ===
    if (lower.match(/^(?:suggest|pick|choose)\s+(?:my\s+)?top\s*3$/i)) {
      await this.app.suggestTop3();
      return { handled: true, response: 'Suggested Top 3 based on your priorities' };
    }

    // === WHAT'S NEXT (cached) ===
    if (lower.match(/^(?:what'?s?\s+next|what\s+should\s+i\s+(?:do|work\s+on))(?:\s+next)?$/i)) {
      // Try to give a quick answer from cached recommendation or top task
      if (this.cachedRecommendation) {
        return { handled: true, response: this.cachedRecommendation };
      }

      // Generate simple recommendation from Top 3 or highest priority
      const top3 = await db.getTop3Items();
      if (top3.length > 0) {
        const next = top3[0];
        const response = `Your top priority is: ${next.text}`;
        return { handled: true, response };
      }

      const todayItems = await db.getTodayItems();
      const rated = todayItems.filter(i => db.isRated(i));
      if (rated.length > 0) {
        rated.sort((a, b) => {
          const aScore = db.calculateScores(a).priority_score || 0;
          const bScore = db.calculateScores(b).priority_score || 0;
          return bScore - aScore;
        });
        const response = `Your highest priority task is: ${rated[0].text}`;
        return { handled: true, response };
      }

      return { handled: true, response: 'No prioritized tasks found. Add some tasks to Today and rate them.' };
    }

    // Not a recognized offline command
    return { handled: false };
  }

  async buildContext() {
    // Get all relevant task data for context
    const allItems = await db.getAllItems();
    const todayItems = await db.getTodayItems();
    const top3Items = await db.getTop3Items();
    const stats = await db.getTodayStats();
    const capacity = await db.getUsableCapacity();

    // Build scored list for Today
    const todayScored = todayItems.map(item => {
      const scores = db.calculateScores(item);
      return {
        id: item.id,
        text: item.text,
        status: item.status,
        tag: item.tag,
        isTop3: item.isTop3,
        scores: scores,
        estimate: item.estimate_bucket,
        confidence: item.confidence,
        dueDate: item.dueDate,
        waiting_on: item.waiting_on,
        isRated: db.isRated(item),
        isMonster: db.isMonster(item)
      };
    }).sort((a, b) => {
      const aUrgent = a.scores?.priority_score >= 15;
      const bUrgent = b.scores?.priority_score >= 15;
      if (aUrgent && !bUrgent) return -1;
      if (!aUrgent && bUrgent) return 1;
      return (b.scores?.priority_score || 0) - (a.scores?.priority_score || 0);
    });

    // Group items by status for summary
    const statusCounts = {};
    for (const item of allItems) {
      if (!item.parent_id) {
        statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;
      }
    }

    // Get waiting items
    const waitingItems = allItems.filter(i => i.status === 'waiting' && !i.parent_id);

    // Get inbox items
    const inboxItems = allItems.filter(i => i.status === 'inbox' && !i.parent_id);

    return {
      today: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
      stats: {
        todayCount: stats.totalTasks,
        ratedCount: stats.ratedCount,
        unratedCount: stats.unratedCount,
        overdueCount: stats.overdueCount,
        top3Count: stats.top3Count,
        bufferedMinutes: stats.totalBuffered,
        capacity: capacity
      },
      statusCounts,
      todayTasks: todayScored.slice(0, 10), // Top 10 for context
      top3: top3Items.map(i => ({ id: i.id, text: i.text, estimate: i.estimate_bucket })),
      waiting: waitingItems.slice(0, 5).map(i => ({ text: i.text, waiting_on: i.waiting_on })),
      inbox: inboxItems.slice(0, 5).map(i => ({ id: i.id, text: i.text }))
    };
  }

  async processWithLLM(userInput) {
    const context = await this.buildContext();

    const systemPrompt = `You are an AI assistant for Battle Plan, a task management app. You help users manage tasks and answer questions about their productivity.

CURRENT STATE:
- Date: ${context.today}
- Today's Tasks: ${context.stats.todayCount} (${context.stats.ratedCount} rated, ${context.stats.unratedCount} unrated)
- Top 3 Priorities: ${context.top3.length}/3 selected
- Time Budget: ${context.stats.bufferedMinutes || 0}/${context.stats.capacity} minutes used
- Overdue: ${context.stats.overdueCount} tasks

TASK COUNTS BY STATUS:
${Object.entries(context.statusCounts).map(([s, c]) => `- ${s}: ${c}`).join('\n')}

TODAY'S TASKS (sorted by priority):
${context.todayTasks.map((t, i) =>
  `${i+1}. ${t.text} ${t.isTop3 ? '[TOP3]' : ''} ${t.isMonster ? '[MONSTER]' : ''} (score: ${t.scores?.priority_score || 'unrated'}, est: ${t.estimate || '?'}min)`
).join('\n')}

TOP 3 PRIORITIES:
${context.top3.length > 0 ? context.top3.map((t, i) => `${i+1}. ${t.text} (${t.estimate}min)`).join('\n') : 'None selected yet'}

WAITING ON:
${context.waiting.length > 0 ? context.waiting.map(t => `- ${t.text} (waiting on: ${t.waiting_on})`).join('\n') : 'Nothing in waiting'}

INBOX:
${context.inbox.length > 0 ? context.inbox.map(t => `- ${t.text}`).join('\n') : 'Inbox is empty'}

SCORING SYSTEM:
- ACE scores (1-5): A=Impact, C=Consequences, E=Friction (effort)
- LMT bonuses (0-2): L=Leverage (unblocks others), M=Mental Match (right energy), T=Time (must be today)
- Priority = (A*2) + (C*2) - E + L + M + T
- MONSTER = 90+ minutes or low confidence (only 1 allowed in Top 3)

COMMANDS YOU CAN RETURN:
Respond with JSON when the user wants to DO something. Format:
{"action": "ACTION_NAME", "params": {...}, "response": "What to say to user"}

Actions available:
- {"action": "add_task", "params": {"text": "task description", "status": "inbox|today|tomorrow|next"}, "response": "..."}
- {"action": "complete_task", "params": {"keyword": "search term"}, "response": "..."}
- {"action": "move_task", "params": {"keyword": "search term", "destination": "today|tomorrow|next|waiting|someday"}, "response": "..."}
- {"action": "delete_task", "params": {"keyword": "search term"}, "response": "..."}
- {"action": "suggest_top3", "params": {}, "response": "..."}
- {"action": "start_focus", "params": {}, "response": "..."}
- {"action": "navigate", "params": {"page": "inbox|today|tomorrow|next|waiting|someday|done|settings"}, "response": "..."}

For QUESTIONS (not commands), respond with plain text advice. Be concise and helpful. Reference specific tasks when relevant.

EXAMPLES:
User: "What should I work on with 30 minutes free?"
Response: Look at your Today tasks, find ones under 30 min with high priority. Suggest specific task.

User: "Why is the tax task ranked first?"
Response: Explain based on its ACE+LMT scores.

User: "Add task call dentist to today"
Response: {"action": "add_task", "params": {"text": "call dentist", "status": "today"}, "response": "Added 'call dentist' to Today"}

Keep responses SHORT (1-3 sentences). Be direct and practical.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...this.conversationHistory,
      { role: 'user', content: userInput }
    ];

    const response = await fetch(this.apiEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages,
        temperature: 0.7,
        max_tokens: 500
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API Error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const assistantMessage = data.choices[0].message.content;

    // Update conversation history
    this.conversationHistory.push(
      { role: 'user', content: userInput },
      { role: 'assistant', content: assistantMessage }
    );

    // Keep history manageable
    while (this.conversationHistory.length > this.maxHistoryLength * 2) {
      this.conversationHistory.shift();
      this.conversationHistory.shift();
    }

    return assistantMessage;
  }

  async handleLLMResponse(response, originalInput) {
    // Try to parse as JSON command
    let command = null;
    try {
      // Check if response looks like JSON
      const trimmed = response.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        command = JSON.parse(trimmed);
      }
    } catch (e) {
      // Not JSON, treat as text response
    }

    if (command && command.action) {
      // Execute the command
      const result = await this.executeCommand(command);
      const displayText = result.message || command.response || 'Done!';
      this.showResponse(displayText);
      this.speak(displayText);
    } else {
      // Plain text response - cache if it's a recommendation
      const lowerInput = originalInput.toLowerCase();
      if (lowerInput.includes('what') && (lowerInput.includes('next') || lowerInput.includes('should') || lowerInput.includes('work'))) {
        this.cachedRecommendation = response;
        localStorage.setItem('aiLastRecommendation', response);
      }

      this.showResponse(response);
      this.speak(response);
    }
  }

  async executeCommand(command) {
    const { action, params } = command;

    switch (action) {
      case 'add_task': {
        const status = params.status || 'inbox';
        const item = await db.addItem(params.text);
        if (status !== 'inbox') {
          if (status === 'today') {
            await db.setToday(item.id);
          } else if (status === 'tomorrow') {
            await db.setTomorrow(item.id);
          } else {
            await db.updateItem(item.id, { status });
          }
        }
        await this.app.render();
        await this.app.updateHUD();
        return { success: true, message: `Added "${params.text}" to ${status}` };
      }

      case 'complete_task': {
        const item = await this.app.findItemByKeyword(params.keyword);
        if (item) {
          await this.app.setItemStatus(item.id, 'done');
          return { success: true, message: `Completed: ${item.text}` };
        }
        return { success: false, message: `Couldn't find task matching "${params.keyword}"` };
      }

      case 'move_task': {
        const item = await this.app.findItemByKeyword(params.keyword);
        if (item) {
          const dest = params.destination;
          if (dest === 'today') {
            await db.setToday(item.id);
          } else if (dest === 'tomorrow') {
            await db.setTomorrow(item.id);
          } else if (dest === 'waiting') {
            await db.updateItem(item.id, { status: 'waiting' });
          } else {
            await db.updateItem(item.id, { status: dest });
          }
          await this.app.render();
          await this.app.updateHUD();
          return { success: true, message: `Moved "${item.text}" to ${dest}` };
        }
        return { success: false, message: `Couldn't find task matching "${params.keyword}"` };
      }

      case 'delete_task': {
        const item = await this.app.findItemByKeyword(params.keyword);
        if (item) {
          await this.app.saveDeleteForUndo(item.id, `Deleted: ${item.text}`);
          await db.deleteItem(item.id);
          await this.app.render();
          await this.app.updateHUD();
          return { success: true, message: `Deleted: ${item.text}` };
        }
        return { success: false, message: `Couldn't find task matching "${params.keyword}"` };
      }

      case 'suggest_top3': {
        await this.app.suggestTop3();
        return { success: true, message: 'Suggested Top 3 priorities based on your scores' };
      }

      case 'start_focus': {
        this.app.startFocus();
        return { success: true, message: 'Starting focus mode' };
      }

      case 'navigate': {
        this.app.navigateTo(params.page);
        return { success: true, message: `Navigating to ${params.page}` };
      }

      default:
        return { success: false, message: `Unknown action: ${action}` };
    }
  }

  showResponse(html) {
    const responseEl = document.getElementById('ai-response');
    if (responseEl) {
      responseEl.innerHTML = html;
    }
  }

  speak(text) {
    if (!this.synthesis) return;

    // Stop any ongoing speech
    this.stopSpeaking();

    // Clean up the text (remove markdown, HTML, etc.)
    const cleanText = text
      .replace(/<[^>]*>/g, '')
      .replace(/\*\*/g, '')
      .replace(/\*/g, '')
      .replace(/`/g, '')
      .replace(/\n+/g, ' ')
      .trim();

    if (!cleanText) return;

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    // Show stop button
    const stopBtn = document.getElementById('ai-stop-speech-btn');
    if (stopBtn) {
      stopBtn.classList.remove('hidden');
    }

    utterance.onend = () => {
      this.isSpeaking = false;
      if (stopBtn) {
        stopBtn.classList.add('hidden');
      }
    };

    utterance.onerror = () => {
      this.isSpeaking = false;
      if (stopBtn) {
        stopBtn.classList.add('hidden');
      }
    };

    this.isSpeaking = true;
    this.synthesis.speak(utterance);
  }

  stopSpeaking() {
    if (this.synthesis) {
      this.synthesis.cancel();
      this.isSpeaking = false;
    }
    const stopBtn = document.getElementById('ai-stop-speech-btn');
    if (stopBtn) {
      stopBtn.classList.add('hidden');
    }
  }
}

// Export for use in app
window.VoiceAssistant = VoiceAssistant;
