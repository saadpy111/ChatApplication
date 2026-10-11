import { inject, Injectable, signal } from '@angular/core';
import { HubConnection, HubConnectionBuilder, HubConnectionState } from '@microsoft/signalr';
import { Subject } from 'rxjs';
import { AuthService } from '../../../core/services/auth.service';
import { PersistedMessage } from '../models/conversation.model';
import { ChatConnectionStatus } from '../models/chat-message.model';

@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly authService = inject(AuthService);
  private readonly incomingMessagesSubject = new Subject<PersistedMessage>();
  private readonly reconnectedSubject = new Subject<void>();
  private hubConnection: HubConnection | null = null;
  private connectionAttempt: Promise<void> | null = null;

  readonly incomingMessages$ = this.incomingMessagesSubject.asObservable();
  readonly reconnected$ = this.reconnectedSubject.asObservable();
  readonly status = signal<ChatConnectionStatus>('disconnected');
  readonly error = signal<string | null>(null);

  async startConnection(): Promise<void> {
    const connection = this.getOrCreateConnection();

    if (connection.state === HubConnectionState.Connected) {
      this.status.set('connected');
      return;
    }

    if (this.connectionAttempt) {
      return this.connectionAttempt;
    }

    this.status.set('connecting');
    this.error.set(null);

    const attempt = connection.start()
      .then(() => this.status.set('connected'))
      .catch((error: unknown) => {
        this.status.set('disconnected');
        this.error.set('Unable to connect to the chat server. Try again.');
        throw error;
      })
      .finally(() => {
        this.connectionAttempt = null;
      });

    this.connectionAttempt = attempt;
    return attempt;
  }

  async sendMessage(conversationId: number, message: string): Promise<PersistedMessage> {
    const connection = this.hubConnection;
    if (!connection || connection.state !== HubConnectionState.Connected) {
      throw new Error('The chat connection is not available.');
    }

    return connection.invoke<PersistedMessage>('SendMessage', conversationId, message);
  }

  private getOrCreateConnection(): HubConnection {
    if (this.hubConnection) {
      return this.hubConnection;
    }

    const connection = new HubConnectionBuilder()
      .withUrl('/chatHub', {
        accessTokenFactory: () => this.authService.getToken() ?? '',
      })
      .withAutomaticReconnect()
      .build();

    connection.on('ReceiveMessage', (message: PersistedMessage) => {
      this.incomingMessagesSubject.next(message);
    });
    connection.onreconnecting(() => this.status.set('reconnecting'));
    connection.onreconnected(() => {
      this.error.set(null);
      this.status.set('connected');
      this.reconnectedSubject.next();
    });
    connection.onclose(() => this.status.set('disconnected'));

    this.hubConnection = connection;
    return connection;
  }
}