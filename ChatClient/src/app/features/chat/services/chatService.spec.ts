import { TestBed } from '@angular/core/testing';
import { HubConnection, HubConnectionBuilder, HubConnectionState } from '@microsoft/signalr';
import { vi } from 'vitest';
import { AuthService } from '../../../core/services/auth.service';
import { PersistedMessage } from '../models/conversation.model';
import { ChatService } from './chatService';

describe('ChatService', () => {
  const message: PersistedMessage = {
    id: 1,
    conversationId: 42,
    senderId: 'sender',
    content: 'Hello',
    createdAt: '2026-10-11T12:00:00Z',
    deliveredAt: null,
    readAt: null,
  };

  let service: ChatService;
  let receiveMessage: ((message: PersistedMessage) => void) | undefined;
  let updateMessageStatus: ((message: PersistedMessage) => void) | undefined;
  let updateUnreadCount: ((update: { conversationId: number; unreadCount: number }) => void) | undefined;
  let userTyping: ((event: { conversationId: number; userId: string; displayName: string }) => void) | undefined;
  let userStoppedTyping: ((event: { conversationId: number; userId: string }) => void) | undefined;
  let notifyReconnect: (() => void) | undefined;
  let notifyReconnecting: (() => void) | undefined;
  let completeConnectionStart: (() => void) | undefined;
  let deferConnectionStart: boolean;
  let connectionState: HubConnectionState;
  let registerHandler: ReturnType<typeof vi.fn>;
  let buildSpy: ReturnType<typeof vi.spyOn>;
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    receiveMessage = undefined;
    updateMessageStatus = undefined;
    updateUnreadCount = undefined;
    userTyping = undefined;
    userStoppedTyping = undefined;
    notifyReconnect = undefined;
    notifyReconnecting = undefined;
    completeConnectionStart = undefined;
    deferConnectionStart = false;
    connectionState = HubConnectionState.Disconnected;
    registerHandler = vi.fn((eventName: string, handler: (message: PersistedMessage) => void) => {
      if (eventName === 'ReceiveMessage') {
        receiveMessage = handler;
      } else if (eventName === 'MessageStatusUpdated') {
        updateMessageStatus = handler;
      } else if (eventName === 'UnreadCountUpdated') {
        updateUnreadCount = handler as unknown as (update: { conversationId: number; unreadCount: number }) => void;
      } else if (eventName === 'UserTyping') {
        userTyping = handler as unknown as (event: { conversationId: number; userId: string; displayName: string }) => void;
      } else if (eventName === 'UserStoppedTyping') {
        userStoppedTyping = handler as unknown as (event: { conversationId: number; userId: string }) => void;
      }
    });
    invoke = vi.fn().mockResolvedValue(message);

    const connection = {
      get state() {
        return connectionState;
      },
      start: vi.fn(() => {
        if (deferConnectionStart) {
          return new Promise<void>((resolve) => {
            completeConnectionStart = () => {
              connectionState = HubConnectionState.Connected;
              resolve();
            };
          });
        }

        connectionState = HubConnectionState.Connected;
        return Promise.resolve();
      }),
      invoke,
      on: registerHandler,
      onreconnecting: vi.fn((handler: () => void) => {
        notifyReconnecting = handler;
      }),
      onreconnected: vi.fn((handler: () => void) => {
        notifyReconnect = handler;
      }),
      onclose: vi.fn(),
    } as unknown as HubConnection;

    buildSpy = vi.spyOn(HubConnectionBuilder.prototype, 'build').mockReturnValue(connection);
    TestBed.configureTestingModule({
      providers: [
        ChatService,
        { provide: AuthService, useValue: { getToken: () => 'token' } },
      ],
    });
    service = TestBed.inject(ChatService);
  });

  afterEach(() => {
    buildSpy.mockRestore();
    TestBed.resetTestingModule();
  });

  it('emits each SignalR message to every active subscriber once', async () => {
    const firstSubscriber = vi.fn();
    const secondSubscriber = vi.fn();
    const firstSubscription = service.incomingMessages$.subscribe(firstSubscriber);
    service.incomingMessages$.subscribe(secondSubscriber);

    await service.startConnection();
    receiveMessage?.(message);

    expect(firstSubscriber).toHaveBeenCalledExactlyOnceWith(message);
    expect(secondSubscriber).toHaveBeenCalledExactlyOnceWith(message);

    firstSubscription.unsubscribe();
    receiveMessage?.(message);
    expect(firstSubscriber).toHaveBeenCalledTimes(1);
    expect(secondSubscriber).toHaveBeenCalledTimes(2);
  });

  it('emits a separate event after SignalR reconnects', async () => {
    const subscriber = vi.fn();
    service.reconnected$.subscribe(subscriber);

    await service.startConnection();
    notifyReconnect?.();

    expect(subscriber).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(service.status()).toBe('connected');
  });

  it('keeps sending messages through the existing SignalR method', async () => {
    await service.startConnection();

    await expect(service.sendMessage(42, 'Hello')).resolves.toEqual(message);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('SendMessage', 42, 'Hello');
  });

  it('invokes delivery and read acknowledgements through the existing connection', async () => {
    await service.startConnection();

    service.acknowledgeDelivered(1);
    service.acknowledgeRead(42, 1);

    expect(invoke).toHaveBeenNthCalledWith(1, 'AcknowledgeDelivered', 1);
    expect(invoke).toHaveBeenNthCalledWith(2, 'AcknowledgeRead', 42, 1);
  });

  it('emits validated message status updates', async () => {
    const subscriber = vi.fn();
    service.messageStatusUpdates$.subscribe(subscriber);
    await service.startConnection();
    const updatedMessage = { ...message, deliveredAt: '2026-10-11T12:01:00Z' };
    updateMessageStatus?.(updatedMessage);

    expect(subscriber).toHaveBeenCalledExactlyOnceWith(updatedMessage);
  });

  it('emits validated authoritative unread count updates', async () => {
    const subscriber = vi.fn();
    service.unreadCountUpdates$.subscribe(subscriber);
    await service.startConnection();
    const update = { conversationId: 42, unreadCount: 3 };

    updateUnreadCount?.(update);
    updateUnreadCount?.({ conversationId: 42, unreadCount: -1 });

    expect(subscriber).toHaveBeenCalledExactlyOnceWith(update);
  });

  it('registers and emits validated typing events from the existing connection', async () => {
    const typingSubscriber = vi.fn();
    const stoppedSubscriber = vi.fn();
    service.userTyping$.subscribe(typingSubscriber);
    service.userStoppedTyping$.subscribe(stoppedSubscriber);
    await service.startConnection();

    const typingEvent = { conversationId: 42, userId: 'friend', displayName: 'Morgan' };
    userTyping?.(typingEvent);
    userTyping?.({ ...typingEvent, conversationId: 0 });
    userStoppedTyping?.({ conversationId: 42, userId: 'friend' });
    userStoppedTyping?.({ conversationId: 42, userId: '' });

    expect(typingSubscriber).toHaveBeenCalledExactlyOnceWith(typingEvent);
    expect(stoppedSubscriber).toHaveBeenCalledExactlyOnceWith({ conversationId: 42, userId: 'friend' });
  });

  it('registers typing handlers only once when connection startup is repeated', async () => {
    await service.startConnection();
    await service.startConnection();

    expect(registerHandler.mock.calls.filter(([eventName]) => eventName === 'UserTyping')).toHaveLength(1);
    expect(registerHandler.mock.calls.filter(([eventName]) => eventName === 'UserStoppedTyping')).toHaveLength(1);
  });

  it('invokes typing events without throwing while disconnected and clears state on connection loss', async () => {
    const connectionLost = vi.fn();
    service.connectionLost$.subscribe(connectionLost);
    service.startTyping(42);
    expect(invoke).not.toHaveBeenCalled();

    await service.startConnection();
    service.startTyping(42);
    service.stopTyping(42);
    expect(invoke).toHaveBeenNthCalledWith(1, 'TypingStarted', 42);
    expect(invoke).toHaveBeenNthCalledWith(2, 'TypingStopped', 42);

    notifyReconnecting?.();
    expect(connectionLost).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('does not invoke the same completed acknowledgement twice', async () => {
    await service.startConnection();

    service.acknowledgeDelivered(1);
    service.acknowledgeDelivered(1);

    expect(invoke).toHaveBeenCalledExactlyOnceWith('AcknowledgeDelivered', 1);
  });

  it('sends a queued historical delivery acknowledgement after connection startup', async () => {
    deferConnectionStart = true;
    const connectionAttempt = service.startConnection();

    service.acknowledgeDelivered(message.id);
    expect(invoke).not.toHaveBeenCalled();

    completeConnectionStart?.();
    await connectionAttempt;

    expect(invoke).toHaveBeenCalledExactlyOnceWith('AcknowledgeDelivered', message.id);
  });

  it('coalesces pending-delivery reconciliation calls through the existing hub', async () => {
    await service.startConnection();

    service.reconcilePendingDeliveries();
    service.reconcilePendingDeliveries();

    expect(invoke).toHaveBeenCalledExactlyOnceWith('ReconcilePendingDeliveries');
  });

  it('queues pending-delivery reconciliation until connection startup completes', async () => {
    deferConnectionStart = true;
    service.reconcilePendingDeliveries();
    expect(invoke).not.toHaveBeenCalled();

    completeConnectionStart?.();
    await service.startConnection();

    expect(invoke).toHaveBeenCalledExactlyOnceWith('ReconcilePendingDeliveries');
  });
});