export interface ChatMessage {
  id: number;
  text: string;
  senderId: string;
  sentAt: Date;
  editedAt?: string | null;
  deletedAt?: string | null;
  isDeleted?: boolean;
  deliveredAt?: string | null;
  readAt?: string | null;
}

export type ChatConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface MessageSendRequest {
  requestId: number;
  conversationId: number;
  text: string;
}

export interface MessageSendResult {
  requestId: number;
  conversationId: number;
  succeeded: boolean;
}

export interface MessageActionState {
  pending: boolean;
  error: string | null;
}