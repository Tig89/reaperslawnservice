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

    this.init();
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
        <button class="ai-close-btn" aria-label="Close">&times;</button>
      </div>
      <div class="ai-panel-content">
        <div id="ai-response" class="ai-response">
          ${this.apiKey ? this.getHelpContent() : this.getSetupContent()}
        </div>
      </div>
      <div class="ai-panel-actions">
        <button id="ai-mic-btn" class="ai-mic-btn" aria-label="Start voice input" ${!this.apiKey ? 'disabled' : ''}>
          <span class="mic-icon">🎤</span>
          <span class="mic-text">${this.apiKey ? 'Tap to speak' : 'API key required'}</span>
        </button>
        <button id="ai-stop-speech-btn" class="ai-stop-speech-btn hidden" aria-label="Stop speaking">
          Stop
        </button>
      </div>
    `;
    document.body.appendChild(panel);
  }

  getHelpContent() {
    return `
      <p class="ai-hint">Tap the mic and ask me anything about your tasks, or give me commands like:</p>
      <ul class="ai-examples">
        <li>"Add task buy groceries"</li>
        <li>"What should I work on next?"</li>
        <li>"Why is this task ranked first?"</li>
        <li>"Move laundry to tomorrow"</li>
        <li>"What's in my waiting list?"</li>
        <li>"I have 30 minutes, what can I do?"</li>
      </ul>
    `;
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

    // Mic button
    document.getElementById('ai-mic-btn').addEventListener('click', () => {
      if (!this.apiKey) {
        return; // Disabled without key
      }
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

    // Save API key button (if present)
    const saveKeyBtn = document.getElementById('ai-save-key-btn');
    if (saveKeyBtn) {
      saveKeyBtn.addEventListener('click', () => this.saveApiKey());
    }

    // Allow Enter to save key
    const keyInput = document.getElementById('ai-api-key-input');
    if (keyInput) {
      keyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.saveApiKey();
      });
    }

    // Close on escape
    document.addEventListener('keydown', (e) => {
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

    // Update UI
    const micBtn = document.getElementById('ai-mic-btn');
    micBtn.disabled = false;
    micBtn.querySelector('.mic-text').textContent = 'Tap to speak';

    this.showResponse(this.getHelpContent());
    this.app.showToast('API key saved! AI assistant is ready.');
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
    this.showResponse(`<em>You said: "${transcript}"</em><br><br>Thinking...`);
    this.isProcessing = true;

    const micBtn = document.getElementById('ai-mic-btn');
    micBtn.classList.add('processing');
    micBtn.querySelector('.mic-text').textContent = 'Processing...';

    try {
      const response = await this.processWithLLM(transcript);
      await this.handleLLMResponse(response, transcript);
    } catch (error) {
      console.error('LLM Error:', error);
      this.showResponse('Sorry, I had trouble processing that. Please try again.');
      this.speak('Sorry, I had trouble processing that.');
    } finally {
      this.isProcessing = false;
      micBtn.classList.remove('processing');
      micBtn.querySelector('.mic-text').textContent = 'Tap to speak';
    }
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
      // Plain text response
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
