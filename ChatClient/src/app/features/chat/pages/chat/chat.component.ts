import { DatePipe } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../services/chat.service';

@Component({
  selector: 'app-chat',
  imports: [DatePipe, FormsModule],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css',
})
export class ChatComponent implements OnInit {
  displayName = 'Guest';
  draft = '';
  sending = false;

  constructor(readonly chat: ChatService) {}

  ngOnInit(): void {
    void this.chat.connect();
  }

  async send(): Promise<void> {
    const message = this.draft.trim();
    const user = this.displayName.trim();

    if (!message || !user || this.sending || this.chat.status() !== 'connected') {
      return;
    }

    this.sending = true;
    try {
      await this.chat.sendMessage(user, message);
      this.draft = '';
    } catch {
      this.chat.error.set('Your message could not be sent. Check the connection and try again.');
    } finally {
      this.sending = false;
    }
  }

  handleEnter(event: Event): void {
    const keyboardEvent = event as KeyboardEvent;
    if (!keyboardEvent.shiftKey) {
      keyboardEvent.preventDefault();
      void this.send();
    }
  }
}