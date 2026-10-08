import { Injectable, signal } from '@angular/core';
import { ChatSignalRService } from '../../../core/services/signalr/chat-signalr.service';
import { ChatConnectionStatus, ChatMessage } from '../models/chat-message.model';

@Injectable({ providedIn: 'root' })
export class ChatService {
  readonly messages = signal<ChatMessage[]>([]);
  readonly status = signal<ChatConnectionStatus>('connecting');
  readonly error = signal<string | null>(null);

  private messageId = 0;

  constructor(private readonly signalR: ChatSignalRService) {
    this.signalR.onMessage((user, message) => {
      this.messages.update((messages) => [
        ...messages,
        { id: ++this.messageId, user, message, receivedAt: new Date() },
      ]);
    });

    this.signalR.onReconnecting(() => this.status.set('reconnecting'));
    this.signalR.onReconnected(() => {
      this.error.set(null);
      this.status.set('connected');
    });
    this.signalR.onClosed(() => this.status.set('disconnected'));
  }

  async connect(): Promise<void> {
    if (this.signalR.isConnected) {
      return;
    }

    this.status.set('connecting');
    this.error.set(null);

    try {
      await this.signalR.start();
      this.status.set('connected');
    } catch {
      this.status.set('disconnected');
      this.error.set('Unable to connect to the chat server. Check that the API is running and try again.');
    }
  }

  async sendMessage(user: string, message: string): Promise<void> {
    if (!this.signalR.isConnected) {
      throw new Error('The chat connection is not available.');
    }

    await this.signalR.sendMessage(user, message);
  }
}