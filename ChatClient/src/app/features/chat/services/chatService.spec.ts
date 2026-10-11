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
  };

  let service: ChatService;
  let receiveMessage: ((message: PersistedMessage) => void) | undefined;
  let notifyReconnect: (() => void) | undefined;
  let connectionState: HubConnectionState;
  let buildSpy: ReturnType<typeof vi.spyOn>;
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    receiveMessage = undefined;
    notifyReconnect = undefined;
    connectionState = HubConnectionState.Disconnected;
    invoke = vi.fn().mockResolvedValue(message);

    const connection = {
      get state() {
        return connectionState;
      },
      start: vi.fn(async () => {
        connectionState = HubConnectionState.Connected;
      }),
      invoke,
      on: vi.fn((eventName: string, handler: (message: PersistedMessage) => void) => {
        if (eventName === 'ReceiveMessage') {
          receiveMessage = handler;
        }
      }),
      onreconnecting: vi.fn(),
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
});