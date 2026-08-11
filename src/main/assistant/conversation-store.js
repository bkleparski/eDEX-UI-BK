'use strict';

const MAX_CONVERSATIONS = 24;
const MAX_MESSAGES = 32;
const MAX_HISTORY_CHARS = 96_000;

function messageSize(message) {
  return (message.content?.length || 0) + JSON.stringify(message.toolCalls || []).length;
}

class ConversationStore {
  constructor({ maxConversations = MAX_CONVERSATIONS, maxMessages = MAX_MESSAGES, maxChars = MAX_HISTORY_CHARS } = {}) {
    this.maxConversations = maxConversations;
    this.maxMessages = maxMessages;
    this.maxChars = maxChars;
    this.conversations = new Map();
  }

  get(id, provider, model) {
    const existing = this.conversations.get(id);
    if (!existing || existing.provider !== provider || existing.model !== model) {
      const conversation = { id, provider, model, messages: [], updatedAt: Date.now() };
      this.conversations.delete(id);
      this.conversations.set(id, conversation);
      this.pruneConversations();
      return conversation;
    }
    existing.updatedAt = Date.now();
    this.conversations.delete(id);
    this.conversations.set(id, existing);
    return existing;
  }

  append(conversation, ...messages) {
    conversation.messages.push(...messages.map((message) => structuredClone(message)));
    while (conversation.messages.length > this.maxMessages) conversation.messages.shift();
    let total = conversation.messages.reduce((sum, message) => sum + messageSize(message), 0);
    while (total > this.maxChars && conversation.messages.length > 1) {
      total -= messageSize(conversation.messages.shift());
    }
    conversation.updatedAt = Date.now();
  }

  reset(id) {
    return this.conversations.delete(id);
  }

  clear() {
    this.conversations.clear();
  }

  pruneConversations() {
    while (this.conversations.size > this.maxConversations) {
      this.conversations.delete(this.conversations.keys().next().value);
    }
  }
}

module.exports = { ConversationStore, MAX_CONVERSATIONS, MAX_HISTORY_CHARS, MAX_MESSAGES };
