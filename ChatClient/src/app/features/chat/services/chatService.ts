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
  private readonly messageStatusUpdatesSubject = new Subject<PersistedMessage>();
  private readonly reconnectedSubject = new Subject<void>();
  private readonly pendingAcknowledgements = new Map<string, { method: string; args: unknown[] }>();
  private readonly acknowledgementAttempts = new Map<string, Promise<void>>();
  private readonly completedAcknowledgements = new Set<string>();
  private pendingDeliveryReconciliation = false;
  private deliveryReconciliationAttempt: Promise<void> | null = null;
  private hubConnection: HubConnection | null = null;
  private connectionAttempt: Promise<void> | null = null;

  readonly incomingMessages$ = this.incomingMessagesSubject.asObservable();
  readonly messageStatusUpdates$ = this.messageStatusUpdatesSubject.asObservable();
  readonly reconnected$ = this.reconnectedSubject.asObservable();
  readonly status = signal<ChatConnectionStatus>('disconnected');
  readonly error = signal<string | null>(null);

  async startConnection(): Promise<void> {
    const connection = this.getOrCreateConnection();

    if (connection.state === HubConnectionState.Connected) {
      this.status.set('connected');
      this.processPendingDeliveryReconciliation();
      return;
    }

    if (this.connectionAttempt) {
      return this.connectionAttempt;
    }

    this.status.set('connecting');
    this.error.set(null);

    const attempt = connection.start()
      .then(() => {
        this.status.set('connected');
        this.retryPendingAcknowledgements();
        this.processPendingDeliveryReconciliation();
      })
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

  acknowledgeDelivered(messageId: number): void {
    this.queueAcknowledgement(`delivered:${messageId}`, 'AcknowledgeDelivered', [messageId]);
  }

  acknowledgeRead(conversationId: number, lastReadMessageId: number): void {
    this.queueAcknowledgement(
      `read:${conversationId}:${lastReadMessageId}`,
      'AcknowledgeRead',
      [conversationId, lastReadMessageId],
    );
  }

  reconcilePendingDeliveries(): void {
    this.pendingDeliveryReconciliation = true;
    if (!this.hubConnection || this.hubConnection.state !== HubConnectionState.Connected) {
      void this.startConnection().catch(() => undefined);
      return;
    }

    this.processPendingDeliveryReconciliation();
  }

  private queueAcknowledgement(key: string, method: string, args: unknown[]): void {
    if (this.completedAcknowledgements.has(key)) {
      return;
    }

    this.pendingAcknowledgements.set(key, { method, args });
    void this.attemptAcknowledgement(key);
  }

  private attemptAcknowledgement(key: string): Promise<void> {
    const existingAttempt = this.acknowledgementAttempts.get(key);
    if (existingAttempt) {
      return existingAttempt;
    }

    const connection = this.hubConnection;
    const acknowledgement = this.pendingAcknowledgements.get(key);
    if (!connection || connection.state !== HubConnectionState.Connected || !acknowledgement) {
      return Promise.resolve();
    }

    const attempt = connection.invoke(acknowledgement.method, ...acknowledgement.args)
      .then(() => {
        this.pendingAcknowledgements.delete(key);
        this.completedAcknowledgements.add(key);
        if (this.completedAcknowledgements.size > 500) {
          const oldest = this.completedAcknowledgements.values().next().value;
          if (oldest) {
            this.completedAcknowledgements.delete(oldest);
          }
        }
      })
      .catch(() => undefined)
      .then(() => undefined)
      .finally(() => this.acknowledgementAttempts.delete(key));
    this.acknowledgementAttempts.set(key, attempt);
    return attempt;
  }

  private retryPendingAcknowledgements(): void {
    for (const key of this.pendingAcknowledgements.keys()) {
      void this.attemptAcknowledgement(key);
    }
  }

  private processPendingDeliveryReconciliation(): void {
    const connection = this.hubConnection;
    if (!this.pendingDeliveryReconciliation || this.deliveryReconciliationAttempt
      || !connection || connection.state !== HubConnectionState.Connected) {
      return;
    }

    this.pendingDeliveryReconciliation = false;
    let failed = false;
    const attempt = connection.invoke('ReconcilePendingDeliveries')
      .catch(() => {
        failed = true;
        this.pendingDeliveryReconciliation = true;
      })
      .then(() => undefined)
      .finally(() => {
        this.deliveryReconciliationAttempt = null;
        if (!failed) {
          this.processPendingDeliveryReconciliation();
        }
      });
    this.deliveryReconciliationAttempt = attempt;
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

    connection.on('ReceiveMessage', (payload: unknown) => {
      if (isPersistedMessage(payload)) {
        this.incomingMessagesSubject.next(payload);
      }
    });
    connection.on('MessageStatusUpdated', (payload: unknown) => {
      if (isPersistedMessage(payload)) {
        this.messageStatusUpdatesSubject.next(payload);
      }
    });
    connection.onreconnecting(() => this.status.set('reconnecting'));
    connection.onreconnected(() => {
      this.error.set(null);
      this.status.set('connected');
      this.retryPendingAcknowledgements();
      this.processPendingDeliveryReconciliation();
      this.reconnectedSubject.next();
    });
    connection.onclose(() => this.status.set('disconnected'));

    this.hubConnection = connection;
    return connection;
  }
}

function isPersistedMessage(payload: unknown): payload is PersistedMessage {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }

  const message = payload as Partial<PersistedMessage>;
  return typeof message.id === 'number'
    && typeof message.conversationId === 'number'
    && typeof message.senderId === 'string'
    && typeof message.content === 'string'
    && typeof message.createdAt === 'string'
    && (message.deliveredAt === null || typeof message.deliveredAt === 'string')
    && (message.readAt === null || typeof message.readAt === 'string');
}