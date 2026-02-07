/**
 * Groq AI Integration for Battle Plan
 * Enables intelligent hands-free voice commands using Groq's fast inference
 * Uses llama-3.1-8b-instant for minimal latency
 */

const GROQ_MODEL = 'llama-3.1-8b-instant';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_STORAGE_KEY = 'battlePlanGroqApiKey';
const GROQ_ENABLED_KEY = 'battlePlanGroqEnabled';

class GroqAssistant {
  constructor() {
    this.apiKey = localStorage.getItem(GROQ_STORAGE_KEY) || '';
    // Default to enabled if not explicitly set
    const storedEnabled = localStorage.getItem(GROQ_ENABLED_KEY);
    this.enabled = storedEnabled === null ? true : storedEnabled === 'true';
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    localStorage.setItem(GROQ_ENABLED_KEY, enabled.toString());
  }

  isEnabled() {
    return this.enabled;
  }

  setApiKey(key) {
    this.apiKey = key;
    localStorage.setItem(GROQ_STORAGE_KEY, key);
  }

  getApiKey() {
    return this.apiKey;
  }

  hasApiKey() {
    return this.apiKey && this.apiKey.startsWith('gsk_');
  }

  // Returns true if AI should be used (enabled + has key)
  shouldUseAI() {
    return this.enabled && this.hasApiKey();
  }

  /**
   * Parse user's voice input and determine intent + extract data
   * Returns a structured command object
   */
  async parseIntent(userInput, context = {}) {
    const today = new Date().toISOString().split('T')[0];
    const dayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()];

    const systemPrompt = `You are a voice command parser for a task management app called Battle Plan. Today is ${today} (${dayOfWeek}).

Parse the user's voice input and return a JSON object with the intent and extracted data.

Available intents:
- "add_task": Add a new task. Extract: text (the task description WITHOUT date/time/recurrence words), scheduled_date (YYYY-MM-DD or null), due_date (YYYY-MM-DD or null), estimate_minutes (15/30/60/90/120/180 or null), recurrence (null/"daily"/"weekly"/"monthly"), recurrence_day (0-6 for weekly where 0=Sunday, 1-31 for monthly, null otherwise), tag ("Home"/"Army"/"Business"/"Other" or null - infer from context if obvious)
- "complete_task": Mark a task done. Extract: keyword (search term to find the task)
- "move_task": Move task to another day. Extract: keyword, target_date (YYYY-MM-DD), target_name ("today"/"tomorrow"/date)
- "find_task": Search for a task. Extract: keyword
- "navigate": Go to a page. Extract: page (inbox/today/tomorrow/done/routines/settings)
- "run_routine": Execute a routine. Extract: routine_name
- "get_stats": Get statistics/reports. Extract: stat_type (today_summary/capacity/free_time/overdue/inbox_count/task_count)
- "start_focus": Start focus timer. Extract: minutes (optional, default 25)
- "stop_focus": Stop focus timer
- "help": User needs help or doesn't know what to say
- "unknown": Cannot determine intent

Date parsing rules:
- "today" = ${today}
- "tomorrow" = calculate tomorrow's date
- "next monday", "this friday", etc = calculate the actual date
- "in 3 days" = calculate date

Recurrence parsing rules:
- "every day"/"daily" = recurrence: "daily"
- "every monday" = recurrence: "weekly", recurrence_day: 1
- "every friday" = recurrence: "weekly", recurrence_day: 5
- "every month"/"monthly" = recurrence: "monthly"
- "every 15th" = recurrence: "monthly", recurrence_day: 15
- When recurrence is set, scheduled_date should be the NEXT occurrence

Tag inference rules:
- Lawn, house, cleaning, cooking, repair = "Home"
- PT, drill, formation, army = "Army"
- Client, invoice, business, money, marketing = "Business"
- If unsure, use null (not "Other")

Time estimate mapping:
- "quick"/"small"/"5 min"/"10 min"/"15 min" = 15
- "half hour"/"30 min" = 30
- "hour"/"1 hour"/"60 min" = 60
- "big"/"large"/"90 min" = 90
- "2 hours" = 120
- "huge"/"half day"/"3 hours" = 180

Current context:
- Current page: ${context.currentPage || 'unknown'}
- Tasks today: ${context.todayCount || 0}
- Tasks in inbox: ${context.inboxCount || 0}
- Top 3 selected: ${context.top3Count || 0}
- Available routines: ${context.routines?.join(', ') || 'none'}

Respond ONLY with valid JSON, no explanation. Example:
{"intent": "add_task", "data": {"text": "Mow lawn", "scheduled_date": "2026-02-13", "due_date": null, "estimate_minutes": 60, "recurrence": "weekly", "recurrence_day": 5, "tag": "Home"}}`;

    // Check if AI is enabled and configured
    if (!this.shouldUseAI()) {
      // Return special intent to signal fallback to simple mode
      return { intent: 'disabled', data: { text: userInput }, error: this.enabled ? 'No API key configured' : 'AI disabled' };
    }

    try {
      const response = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userInput }
          ],
          temperature: 0.1,
          max_tokens: 200,
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('Groq API error:', error);
        return { intent: 'unknown', data: {}, error: 'API error' };
      }

      const result = await response.json();
      const content = result.choices[0]?.message?.content;

      try {
        return JSON.parse(content);
      } catch (e) {
        console.error('Failed to parse Groq response:', content);
        return { intent: 'unknown', data: {}, error: 'Parse error' };
      }
    } catch (error) {
      console.error('Groq request failed:', error);
      return { intent: 'unknown', data: {}, error: error.message };
    }
  }

  /**
   * Parse a typed task input into structured data (NLP for inbox).
   * Lighter prompt than parseIntent - only extracts task fields, no command routing.
   */
  async parseTaskInput(text) {
    if (!this.shouldUseAI()) return null;

    const today = new Date().toISOString().split('T')[0];
    const dayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()];

    const systemPrompt = `Parse this task input and extract structured data. Today is ${today} (${dayOfWeek}).

Return JSON with these fields:
- text: the task description (strip out date/time/recurrence words)
- scheduled_date: YYYY-MM-DD or null
- due_date: YYYY-MM-DD or null (use for deadlines: "by Friday", "due March 1")
- estimate_minutes: 15/30/60/90/120/180 or null
- recurrence: null/"daily"/"weekly"/"monthly"
- recurrence_day: 0-6 for weekly (0=Sun), 1-31 for monthly, null otherwise
- tag: "Home"/"Army"/"Business" or null (infer from context: lawn/house=Home, PT/drill=Army, client/invoice=Business)

Rules:
- "every friday" = recurrence:"weekly", recurrence_day:5, scheduled_date=next friday
- "every day"/"daily" = recurrence:"daily"
- "tomorrow" = scheduled_date = tomorrow's date
- "at 3pm" = strip from text (time-of-day not stored yet)
- Keep the text clean: "Mow lawn every Friday at 3pm" -> text:"Mow lawn"

Respond ONLY with valid JSON.`;

    try {
      const response = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text }
          ],
          temperature: 0.1,
          max_tokens: 200,
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) return null;

      const result = await response.json();
      const content = result.choices[0]?.message?.content;
      try {
        return JSON.parse(content);
      } catch (e) {
        return null;
      }
    } catch (error) {
      return null;
    }
  }

  /**
   * Generate a natural language response for stats/queries
   */
  async generateStatsResponse(stats, query) {
    const systemPrompt = `You are a helpful voice assistant for a task management app. Give brief, conversational responses (1-2 sentences max). Be encouraging but not overly enthusiastic. Today's stats:

- Tasks for today: ${stats.todayCount}
- Tasks completed today: ${stats.completedToday}
- Tasks in inbox (unprocessed): ${stats.inboxCount}
- Top 3 tasks selected: ${stats.top3Count}
- Top 3 time committed: ${stats.top3Minutes} minutes
- Available capacity: ${stats.capacity} minutes
- Free time remaining: ${stats.freeTime} minutes
- Overdue tasks: ${stats.overdueCount}
- Tasks for tomorrow: ${stats.tomorrowCount}

The user asked: "${query}"

Respond conversationally and briefly.`;

    // Check if AI is enabled and configured - fall back to static response if not
    if (!this.shouldUseAI()) {
      return this.getFallbackStatsResponse(stats, query);
    }

    try {
      const response = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: query }
          ],
          temperature: 0.7,
          max_tokens: 100
        })
      });

      if (!response.ok) {
        return this.getFallbackStatsResponse(stats, query);
      }

      const result = await response.json();
      return result.choices[0]?.message?.content || this.getFallbackStatsResponse(stats, query);
    } catch (error) {
      return this.getFallbackStatsResponse(stats, query);
    }
  }

  /**
   * Fallback stats response when AI is unavailable
   */
  getFallbackStatsResponse(stats, query) {
    const q = query.toLowerCase();

    if (q.includes('free time') || q.includes('available')) {
      return `You have ${stats.freeTime} minutes of free time today.`;
    }
    if (q.includes('capacity')) {
      return `Today's capacity is ${stats.capacity} minutes. Top 3 uses ${stats.top3Minutes} minutes.`;
    }
    if (q.includes('today') || q.includes('summary')) {
      return `You have ${stats.todayCount} tasks today, ${stats.top3Count} in your Top 3.`;
    }
    if (q.includes('overdue')) {
      return stats.overdueCount > 0
        ? `You have ${stats.overdueCount} overdue tasks.`
        : `No overdue tasks. Nice work!`;
    }
    if (q.includes('inbox')) {
      return `You have ${stats.inboxCount} items in your inbox.`;
    }
    if (q.includes('tomorrow')) {
      return `You have ${stats.tomorrowCount} tasks scheduled for tomorrow.`;
    }

    return `Today: ${stats.todayCount} tasks, ${stats.top3Count} in Top 3, ${stats.freeTime} min free.`;
  }

  /**
   * Quick date calculation helper
   */
  calculateDate(offset) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().split('T')[0];
  }
}

// Export singleton
const groqAssistant = new GroqAssistant();
