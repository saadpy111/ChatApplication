export interface ChatMessage {
  id: number;
  text: string;
  sender: 'me' | 'friend';
  sentAt: Date;
}

export type ChatConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';