import { DatePipe } from '@angular/common';
import { AfterViewChecked, Component, ElementRef, input, output, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatConnectionStatus, ChatMessage } from '../../models/chat-message.model';
import { User } from '../../../users/models/user';

@Component({
  selector: 'app-chat-conversation',
  imports: [DatePipe, FormsModule],
  templateUrl: './chat-conversation.component.html',
  styleUrl: './chat-conversation.component.css',
})
export class ChatConversationComponent implements AfterViewChecked {
  @ViewChild('messageList') private messageList?: ElementRef<HTMLElement>;

  readonly friend = input<User | null>(null);
  readonly conversationId = input<number | null>(null);
  readonly messages = input<ChatMessage[]>([]);
  readonly initialLoading = input(false);
  readonly loadingOlder = input(false);
  readonly historyError = input<string | null>(null);
  readonly hasMore = input(false);
  readonly olderPageVersion = input(0);
  readonly connectionStatus = input<ChatConnectionStatus>('disconnected');
  readonly connectionError = input<string | null>(null);
  readonly sending = input(false);
  readonly messageSubmitted = output<string>();
  readonly loadOlder = output<void>();
  readonly retryHistory = output<void>();
  readonly retryConnection = output<void>();

  draft = '';
  private previousMessageCount = 0;
  private previousHistoryVersion = 0;
  private nearBottom = true;
  private preserveScroll = false;
  private previousScrollHeight = 0;
  private previousScrollTop = 0;

  ngAfterViewChecked(): void {
    const element = this.messageList?.nativeElement;
    if (!element) {
      return;
    }

    const historyVersion = this.olderPageVersion();
    const messages = this.messages();
    if (this.preserveScroll && this.historyError() && !this.loadingOlder()) {
      this.preserveScroll = false;
    }
    if (historyVersion !== this.previousHistoryVersion) {
      this.previousHistoryVersion = historyVersion;
      if (this.preserveScroll) {
        element.scrollTop = this.previousScrollTop + element.scrollHeight - this.previousScrollHeight;
        this.preserveScroll = false;
      }
      this.previousMessageCount = messages.length;
      return;
    }

    if (messages.length !== this.previousMessageCount) {
      if (messages.length > this.previousMessageCount && (this.previousMessageCount === 0 || this.nearBottom)) {
        element.scrollTop = element.scrollHeight;
      }
      this.previousMessageCount = messages.length;
    }
  }

  handleScroll(event: Event): void {
    const element = event.currentTarget as HTMLElement;
    this.nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
    if (element.scrollTop < 70 && this.hasMore() && !this.loadingOlder()) {
      this.preserveScroll = true;
      this.previousScrollHeight = element.scrollHeight;
      this.previousScrollTop = element.scrollTop;
      this.loadOlder.emit();
    }
  }

  send(): void {
    const message = this.draft.trim();
    if (!message || !this.conversationId() || this.sending() || this.connectionStatus() !== 'connected') {
      return;
    }

    this.messageSubmitted.emit(message);
    this.draft = '';
  }

  handleEnter(event: Event): void {
    const keyboardEvent = event as KeyboardEvent;
    if (!keyboardEvent.shiftKey) {
      keyboardEvent.preventDefault();
      this.send();
    }
  }
}