export interface ChatMessage {
  id: number;
  user: string;
  message: string;
  receivedAt: Date;
}

export type ChatConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';