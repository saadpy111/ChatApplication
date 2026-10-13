export interface ConversationSummary {
  conversationId: number;
  otherUserId: string;
  otherUsername: string;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  unreadCount: number;
  otherUserIsOnline?: boolean;
  otherUserLastSeenAt?: string | null;
  otherUserPresenceChangedAt?: string | null;
}

export interface UserPresence {
  isOnline: boolean;
  lastSeenAt: string | null;
  changedAt: string | null;
}

export interface UnreadCountUpdate {
  conversationId: number;
  unreadCount: number;
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
  deliveredAt: string | null;
  readAt: string | null;
}

export interface MessagePage {
  messages: PersistedMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface MessageSearchResult {
  messageId: number;
  conversationId: number;
  content: string;
  senderId: string;
  senderDisplayName: string;
  otherUserId: string;
  otherUsername: string;
  createdAt: string;
}

export interface MessageSearchPage {
  results: MessageSearchResult[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}