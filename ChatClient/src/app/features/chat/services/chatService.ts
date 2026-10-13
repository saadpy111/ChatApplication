import { inject, Injectable, signal } from '@angular/core';
import { HubConnection, HubConnectionBuilder, HubConnectionState } from '@microsoft/signalr';
import { Subject } from 'rxjs';
import { AuthService } from '../../../core/services/auth.service';
import { ConversationSummary, MessageReactionUpdate, PersistedMessage, UnreadCountUpdate, UserPresence } from '../models/conversation.model';
import { ChatConnectionStatus } from '../models/chat-message.model';

@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly authService = inject(AuthService);
  private readonly incomingMessagesSubject = new Subject<PersistedMessage>();
  private readonly messageStatusUpdatesSubject = new Subject<PersistedMessage>();
  private readonly messageEditsSubject = new Subject<PersistedMessage>();
  private readonly messageDeletesSubject = new Subject<PersistedMessage>();
  private readonly unreadCountUpdatesSubject = new Subject<UnreadCountUpdate>();
  private readonly reconnectedSubject = new Subject<void>();
  private readonly userTypingSubject = new Subject<UserTypingEvent>();
  private readonly userStoppedTypingSubject = new Subject<UserStoppedTypingEvent>();
  private readonly connectionLostSubject = new Subject<void>();
  private readonly messageReactionUpdatesSubject = new Subject<MessageReactionUpdate>();
  private readonly pendingAcknowledgements = new Map<string, { method: string; args: unknown[] }>();
  private readonly acknowledgementAttempts = new Map<string, Promise<void>>();
  private readonly completedAcknowledgements = new Set<string>();
  private pendingDeliveryReconciliation = false;
  private deliveryReconciliationAttempt: Promise<void> | null = null;
  private hubConnection: HubConnection | null = null;
  private connectionAttempt: Promise<void> | null = null;

  readonly incomingMessages$ = this.incomingMessagesSubject.asObservable();
  readonly messageStatusUpdates$ = this.messageStatusUpdatesSubject.asObservable();
  readonly messageEdits$ = this.messageEditsSubject.asObservable();
  readonly messageDeletes$ = this.messageDeletesSubject.asObservable();
  readonly unreadCountUpdates$ = this.unreadCountUpdatesSubject.asObservable();
  readonly reconnected$ = this.reconnectedSubject.asObservable();
  readonly userTyping$ = this.userTypingSubject.asObservable();
  readonly userStoppedTyping$ = this.userStoppedTypingSubject.asObservable();
  readonly connectionLost$ = this.connectionLostSubject.asObservable();
  readonly messageReactionUpdates$ = this.messageReactionUpdatesSubject.asObservable();
  readonly status = signal<ChatConnectionStatus>('disconnected');
  readonly error = signal<string | null>(null);
  readonly presenceByUserId = signal<Record<string, UserPresence>>({})

  setConversationPresence(conversations: ConversationSummary[]): void {
    for (const conversation of conversations) {
      this.applyPresenceUpdate({
        userId: conversation.otherUserId,
        isOnline: conversation.otherUserIsOnline ?? false,
        lastSeenAt: conversation.otherUserLastSeenAt ?? null,
        changedAt: conversation.otherUserPresenceChangedAt ?? conversation.otherUserLastSeenAt ?? null,
      });
    }
  }

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
        this.presenceByUserId.set({});
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

  startTyping(conversationId: number): void {
    this.invokeTypingMethod('TypingStarted', conversationId);
  }

  stopTyping(conversationId: number): void {
    this.invokeTypingMethod('TypingStopped', conversationId);
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

  async reactToMessage(conversationId: number, messageId: number, emoji: string): Promise<void> {
    const connection = this.hubConnection;
    if (!connection || connection.state !== HubConnectionState.Connected) {
      throw new Error('The chat connection is not available.');
    }

    await connection.invoke('ReactToMessage', conversationId, messageId, emoji);
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
    connection.on('MessageEdited', (payload: unknown) => {
      if (isPersistedMessage(payload)) {
        this.messageEditsSubject.next(payload);
      }
    });
    connection.on('MessageDeleted', (payload: unknown) => {
      if (isPersistedMessage(payload)) {
        this.messageDeletesSubject.next(payload);
      }
    });
    connection.on('UnreadCountUpdated', (payload: unknown) => {
      if (isUnreadCountUpdate(payload)) {
        this.unreadCountUpdatesSubject.next(payload);
      }
    });
    connection.on('UserTyping', (payload: unknown) => {
      if (isUserTypingEvent(payload)) {
        this.userTypingSubject.next(payload);
      }
    });
    connection.on('UserStoppedTyping', (payload: unknown) => {
      if (isUserStoppedTypingEvent(payload)) {
        this.userStoppedTypingSubject.next(payload);
      }
    });
    connection.on('UserOnline', (payload: unknown) => {
      if (isPresenceUpdate(payload)) {
        this.applyPresenceUpdate(payload);
      }
    });
    connection.on('UserOffline', (payload: unknown) => {
      if (isPresenceUpdate(payload)) {
        this.applyPresenceUpdate(payload);
      }
    });
    connection.on('MessageReactionUpdated', (payload: unknown) => {
      if (isMessageReactionUpdate(payload)) {
        this.messageReactionUpdatesSubject.next(payload);
      }
    });
    connection.onreconnecting(() => {
      this.status.set('reconnecting');
      this.presenceByUserId.set({});
      this.connectionLostSubject.next();
    });
    connection.onreconnected(() => {
      this.error.set(null);
      this.status.set('connected');
      this.retryPendingAcknowledgements();
      this.processPendingDeliveryReconciliation();
      this.reconnectedSubject.next();
    });
    connection.onclose(() => {
      this.status.set('disconnected');
      this.presenceByUserId.set({});
      this.connectionLostSubject.next();
    });

    this.hubConnection = connection;
    return connection;
  }

  private applyPresenceUpdate(update: {
    userId: string;
    isOnline: boolean;
    lastSeenAt: string | null;
    changedAt: string | null;
  }): void {
    this.presenceByUserId.update((current) => {
      const previous = current[update.userId];
      if (previous?.changedAt && update.changedAt &&
          Date.parse(previous.changedAt) > Date.parse(update.changedAt)) {
        return current;
      }

      return {
        ...current,
        [update.userId]: {
          isOnline: update.isOnline,
          lastSeenAt: update.lastSeenAt,
          changedAt: update.changedAt,
        },
      };
    });
  }

  private invokeTypingMethod(method: 'TypingStarted' | 'TypingStopped', conversationId: number): void {
    const connection = this.hubConnection;
    if (!connection || connection.state !== HubConnectionState.Connected) {
      return;
    }

    void connection.invoke(method, conversationId).catch(() => undefined);
  }
}

export interface UserTypingEvent {
  conversationId: number;
  userId: string;
  displayName: string;
}

export interface UserStoppedTypingEvent {
  conversationId: number;
  userId: string;
}

interface PresenceUpdate {
  userId: string;
  isOnline: boolean;
  lastSeenAt: string | null;
  changedAt: string;
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
    && (message.editedAt === undefined || message.editedAt === null || typeof message.editedAt === 'string')
    && (message.deletedAt === undefined || message.deletedAt === null || typeof message.deletedAt === 'string')
    && (message.isDeleted === undefined || typeof message.isDeleted === 'boolean')
    && (message.deliveredAt === null || typeof message.deliveredAt === 'string')
    && (message.readAt === null || typeof message.readAt === 'string');
}

function isUnreadCountUpdate(payload: unknown): payload is UnreadCountUpdate {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }

  const update = payload as Partial<UnreadCountUpdate>;
  return Number.isSafeInteger(update.conversationId) && Number(update.conversationId) > 0
    && Number.isSafeInteger(update.unreadCount) && Number(update.unreadCount) >= 0;
}

function isUserTypingEvent(payload: unknown): payload is UserTypingEvent {
  if (!isRecord(payload)) {
    return false;
  }

  return isConversationId(payload['conversationId'])
    && typeof payload['userId'] === 'string' && payload['userId'].length > 0
    && typeof payload['displayName'] === 'string' && payload['displayName'].length > 0;
}

function isUserStoppedTypingEvent(payload: unknown): payload is UserStoppedTypingEvent {
  if (!isRecord(payload)) {
    return false;
  }

  return isConversationId(payload['conversationId'])
    && typeof payload['userId'] === 'string' && payload['userId'].length > 0;
}

function isConversationId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPresenceUpdate(payload: unknown): payload is PresenceUpdate {
  if (!isRecord(payload)) {
    return false;
  }

  return typeof payload['userId'] === 'string' && payload['userId'].length > 0
    && typeof payload['isOnline'] === 'boolean'
    && (payload['lastSeenAt'] === null || typeof payload['lastSeenAt'] === 'string')
    && typeof payload['changedAt'] === 'string'
    && Number.isFinite(Date.parse(payload['changedAt']))
    && (payload['lastSeenAt'] === null || Number.isFinite(Date.parse(payload['lastSeenAt'])));
}

function isMessageReactionUpdate(payload: unknown): payload is MessageReactionUpdate {
  if (!isRecord(payload)) {
    return false;
  }

  return isConversationId(payload['conversationId'])
    && isConversationId(payload['messageId'])
    && Array.isArray(payload['reactions']);
}