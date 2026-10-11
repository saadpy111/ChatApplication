export interface ConversationSummary {
  conversationId: number;
  otherUserId: string;
  otherUsername: string;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface OpenConversation {
  conversationId: number;
  userId: string;
  username: string;
  createdAt: string;
}

export interface PersistedMessage {
  id: number;
  conversationId: number;
  senderId: string;
  content: string;
  createdAt: string;
}

export interface MessagePage {
  messages: PersistedMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}