import { Injectable } from '@angular/core';
import { HubConnection, HubConnectionBuilder } from '@microsoft/signalr';

@Injectable({ providedIn: 'root' })
export class ChatSignalRService {
  private readonly connection: HubConnection = new HubConnectionBuilder()
    .withUrl('/chatHub')
    .withAutomaticReconnect()
    .build();

  onMessage(handler: (user: string, message: string) => void): void {
    this.connection.on('ReceiveMessage', handler);
  }

  onReconnecting(handler: () => void): void {
    this.connection.onreconnecting(handler);
  }

  onReconnected(handler: () => void): void {
    this.connection.onreconnected(handler);
  }

  onClosed(handler: () => void): void {
    this.connection.onclose(handler);
  }

  get isConnected(): boolean {
    return this.connection.state === 'Connected';
  }

  start(): Promise<void> {
    return this.connection.start();
  }

  sendMessage(user: string, message: string): Promise<void> {
    return this.connection.invoke('SendMessage', user, message);
  }
}