import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { ChatConversationComponent } from './chat-conversation.component';
import { MessageSendRequest, MessageSendResult } from '../../models/chat-message.model';

describe('ChatConversationComponent composer', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<ChatConversationComponent>>;
  let component: ChatConversationComponent;
  let sentRequests: MessageSendRequest[];
  let typingStarted: number[];
  let typingStopped: number[];
  let readAcknowledgements: { conversationId: number; lastReadMessageId: number }[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ChatConversationComponent] }).compileComponents();
    fixture = TestBed.createComponent(ChatConversationComponent);
    component = fixture.componentInstance;
    sentRequests = [];
    typingStarted = [];
    typingStopped = [];
    readAcknowledgements = [];
    component.messageSubmitted.subscribe((request) => sentRequests.push(request));
    component.typingStarted.subscribe((conversationId) => typingStarted.push(conversationId));
    component.typingStopped.subscribe((conversationId) => typingStopped.push(conversationId));
    component.readAcknowledged.subscribe((request) => readAcknowledgements.push(request));
    fixture.componentRef.setInput('friend', { userId: 'friend-id', username: 'Morgan' });
    fixture.componentRef.setInput('conversationId', 42);
    fixture.componentRef.setInput('connectionStatus', 'connected');
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('restores textarea focus after Enter sends and allows consecutive sends', () => {
    const textarea = getTextarea();
    enterMessage(textarea, 'First message');
    expect(sentRequests[0]?.text).toBe('First message');
    expect(component.draft).toBe('');

    completeSend({ requestId: 1, conversationId: 42, succeeded: true });
    expect(document.activeElement).toBe(textarea);

    enterMessage(textarea, 'Second message');
    expect(sentRequests[1]?.text).toBe('Second message');
    expect(sentRequests[1]?.requestId).toBe(2);
    completeSend({ requestId: 2, conversationId: 42, succeeded: true });
    expect(document.activeElement).toBe(textarea);
  });

  it('focuses the textarea after an active conversation renders', async () => {
    await fixture.whenStable();
    expect(document.activeElement).toBe(getTextarea());
  });

  it('focuses after selecting, switching, and recreating the conditional composer', async () => {
    const switchingFixture = TestBed.createComponent(ChatConversationComponent);
    switchingFixture.componentRef.setInput('connectionStatus', 'connected');
    switchingFixture.detectChanges();
    expect(switchingFixture.nativeElement.querySelector('textarea')).toBeNull();

    switchingFixture.componentRef.setInput('friend', { userId: 'first-id', username: 'First' });
    switchingFixture.componentRef.setInput('conversationId', 42);
    switchingFixture.detectChanges();
    await switchingFixture.whenStable();
    const firstTextarea = switchingFixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(firstTextarea);

    switchingFixture.componentRef.setInput('friend', { userId: 'second-id', username: 'Second' });
    switchingFixture.componentRef.setInput('conversationId', 43);
    switchingFixture.detectChanges();
    await switchingFixture.whenStable();
    expect(switchingFixture.nativeElement.querySelector('textarea')).toBe(firstTextarea);
    expect(document.activeElement).toBe(firstTextarea);

    switchingFixture.componentRef.setInput('friend', null);
    switchingFixture.componentRef.setInput('conversationId', null);
    switchingFixture.detectChanges();
    expect(switchingFixture.nativeElement.querySelector('textarea')).toBeNull();

    switchingFixture.componentRef.setInput('friend', { userId: 'third-id', username: 'Third' });
    switchingFixture.componentRef.setInput('conversationId', 44);
    switchingFixture.detectChanges();
    await switchingFixture.whenStable();
    expect(document.activeElement).toBe(switchingFixture.nativeElement.querySelector('textarea'));
    switchingFixture.destroy();
  });

  it('waits for the composer to become enabled before focusing', async () => {
    const textarea = getTextarea();
    fixture.componentRef.setInput('connectionStatus', 'disconnected');
    fixture.componentRef.setInput('conversationId', 43);
    textarea.blur();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(textarea.disabled).toBe(true);
    expect(document.activeElement).not.toBe(textarea);

    fixture.componentRef.setInput('connectionStatus', 'connected');
    fixture.detectChanges();
    await fixture.whenStable();
    await fixture.whenRenderingDone();
    expect(textarea.disabled).toBe(false);
    expect(document.activeElement).toBe(textarea);
  });

  it('does not focus the textarea when there is no active conversation', async () => {
    const inactiveFixture = TestBed.createComponent(ChatConversationComponent);
    inactiveFixture.componentRef.setInput('friend', { userId: 'friend-id', username: 'Morgan' });
    inactiveFixture.componentRef.setInput('conversationId', 42);
    inactiveFixture.componentRef.setInput('conversationActive', false);
    inactiveFixture.detectChanges();
    await inactiveFixture.whenStable();
    expect(document.activeElement).not.toBe(inactiveFixture.nativeElement.querySelector('textarea'));
    inactiveFixture.destroy();
  });

  it('restores textarea focus after the Send button succeeds', () => {
    const textarea = getTextarea();
    setDraft('Button message');
    getSendButton().click();
    fixture.detectChanges();
    expect(sentRequests[0]?.text).toBe('Button message');

    completeSend({ requestId: 1, conversationId: 42, succeeded: true });
    expect(document.activeElement).toBe(textarea);
  });

  it('restores textarea focus when submission starts with the Send button focused', () => {
    const textarea = getTextarea();
    setDraft('Keyboard button message');
    getSendButton().focus();

    component.send();
    fixture.detectChanges();
    expect(sentRequests[0]?.text).toBe('Keyboard button message');

    completeSend({ requestId: 1, conversationId: 42, succeeded: true });
    expect(document.activeElement).toBe(textarea);
  });

  it('restores focus when the send began with unknown focus origin but focus returns to the composer', () => {
    const textarea = getTextarea();
    const otherControl = document.createElement('button');
    fixture.nativeElement.appendChild(otherControl);
    setDraft('Unknown focus origin');
    otherControl.focus();

    component.send();
    fixture.detectChanges();
    otherControl.blur();
    completeSend({ requestId: 1, conversationId: 42, succeeded: true });

    expect(document.activeElement).toBe(textarea);
  });

  it('does not steal focus when the user moves to another control during a successful send', () => {
    const textarea = getTextarea();
    enterMessage(textarea, 'Keep focus elsewhere');
    const otherControl = document.createElement('button');
    fixture.nativeElement.appendChild(otherControl);
    otherControl.focus();

    completeSend({ requestId: 1, conversationId: 42, succeeded: true });

    expect(document.activeElement).toBe(otherControl);
  });

  it('keeps Shift+Enter for newlines and does not submit empty messages', () => {
    const textarea = getTextarea();
    const shiftEnter = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    textarea.dispatchEvent(shiftEnter);
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(sentRequests).toHaveLength(0);

    setDraft('  \n  ');
    component.send();
    expect(sentRequests).toHaveLength(0);
  });

  it('throttles typing starts and stops after composer inactivity', () => {
    vi.useFakeTimers();
    setDraft('Hello');
    setDraft('Hello again');
    expect(typingStarted).toEqual([42]);

    vi.advanceTimersByTime(1800);
    expect(typingStopped).toEqual([42]);
  });

  it('refreshes typing for sustained input and stops after a successful send', () => {
    vi.useFakeTimers();
    setDraft('Hello');
    vi.advanceTimersByTime(1500);
    setDraft('Hello there');
    vi.advanceTimersByTime(1100);
    setDraft('Hello again');
    expect(typingStarted).toEqual([42, 42]);

    component.send();
    completeSend({ requestId: 1, conversationId: 42, succeeded: true });
    expect(typingStopped).toEqual([42]);
  });

  it('stops typing on conversation switch and component destruction', () => {
    setDraft('Hello');
    fixture.componentRef.setInput('conversationId', 43);
    fixture.detectChanges();
    expect(typingStopped).toEqual([42]);

    setDraft('Again');
    fixture.destroy();
    expect(typingStopped).toEqual([42]);
  });

  it('restores the draft after a failed send without stealing focus', () => {
    const textarea = getTextarea();
    enterMessage(textarea, 'Please retry this');
    const otherControl = document.createElement('button');
    fixture.nativeElement.appendChild(otherControl);
    otherControl.focus();

    completeSend({ requestId: 1, conversationId: 42, succeeded: false });
    expect(component.draft).toBe('Please retry this');
    expect(document.activeElement).toBe(otherControl);
  });

  it('does not let an old send steal focus after the conversation changes', () => {
    const textarea = getTextarea();
    enterMessage(textarea, 'Old conversation');
    fixture.componentRef.setInput('sending', true);
    fixture.detectChanges();
    fixture.componentRef.setInput('conversationId', 43);
    fixture.detectChanges();
    const otherControl = document.createElement('button');
    fixture.nativeElement.appendChild(otherControl);
    otherControl.focus();
    fixture.componentRef.setInput('sendResult', { requestId: 1, conversationId: 42, succeeded: true } satisfies MessageSendResult);
    fixture.detectChanges();
    expect(document.activeElement).toBe(otherControl);
  });

  it('keeps the same focused textarea when messages update', () => {
    const textarea = getTextarea();
    textarea.focus();
    fixture.componentRef.setInput('messages', [{ id: 1, text: 'Incoming', senderId: 'friend-id', sentAt: new Date() }]);
    fixture.detectChanges();
    expect(getTextarea()).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
  });

  it('waits for the target message to render, scrolls the message list, and expires the highlight', () => {
    vi.useFakeTimers();
    const messageList = fixture.nativeElement.querySelector('.message-list') as HTMLElement;
    Object.defineProperty(messageList, 'clientHeight', { value: 400 });
    vi.spyOn(messageList, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 500, height: 400 } as DOMRect);

    fixture.componentRef.setInput('highlightRequestVersion', 1);
    fixture.detectChanges();

    fixture.componentRef.setInput('messages', [
      { id: 501, text: 'Historical target', senderId: 'friend-id', sentAt: new Date() },
    ]);
    fixture.detectChanges();
    const target = fixture.nativeElement.querySelector('[data-message-id="501"]') as HTMLElement;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 350, bottom: 410, height: 60 } as DOMRect);
    Object.defineProperty(messageList, 'scrollHeight', { value: 1000 });
    fixture.componentRef.setInput('highlightedMessageId', 501);
    fixture.detectChanges();

    expect(messageList.scrollTop).toBe(80);
    expect(target.id).toBe('message-501');
    expect(target.classList.contains('search-highlight')).toBe(true);

    vi.advanceTimersByTime(2800);
    fixture.detectChanges();
    expect(target.classList.contains('search-highlight')).toBe(false);
  });

  it('reports a target that is missing after message loading completes', () => {
    const failures: { conversationId: number; messageId: number; requestVersion: number }[] = [];
    component.searchNavigationFailed.subscribe((failure) => failures.push(failure));
    fixture.componentRef.setInput('highlightRequestVersion', 7);
    fixture.componentRef.setInput('highlightedMessageId', 999);
    fixture.detectChanges();
    fixture.detectChanges();

    expect(failures).toEqual([{ conversationId: 42, messageId: 999, requestVersion: 7 }]);
  });

  it('renders sent, delivered, and read states only for own messages', () => {
    fixture.componentRef.setInput('currentUserId', 'me');
    fixture.componentRef.setInput('messages', [
      { id: 1, text: 'Sent', senderId: 'me', sentAt: new Date() },
      { id: 2, text: 'Delivered', senderId: 'me', sentAt: new Date(), deliveredAt: '2026-10-11T12:00:00Z' },
      { id: 3, text: 'Read', senderId: 'me', sentAt: new Date(), deliveredAt: '2026-10-11T12:00:00Z', readAt: '2026-10-11T12:01:00Z' },
      { id: 4, text: 'Incoming', senderId: 'friend-id', sentAt: new Date(), deliveredAt: null, readAt: null },
    ]);
    fixture.detectChanges();

    const indicators = [...fixture.nativeElement.querySelectorAll('.message-status')] as HTMLElement[];
    expect(indicators.map((indicator) => indicator.getAttribute('aria-label'))).toEqual(['Sent', 'Delivered', 'Read']);
    expect(indicators.map((indicator) => indicator.textContent)).toEqual(['✓', '✓✓', '✓✓']);
  });

  it('acknowledges visible incoming messages once and disconnects observation on destroy', () => {
    class TestIntersectionObserver {
      static instance: TestIntersectionObserver;
      readonly targets: Element[] = [];
      disconnected = false;

      constructor(private readonly callback: IntersectionObserverCallback) {
        TestIntersectionObserver.instance = this;
      }

      observe(target: Element): void {
        this.targets.push(target);
      }

      disconnect(): void {
        this.disconnected = true;
      }

      trigger(target: Element): void {
        this.callback(
          [{ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
    }

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
    fixture.componentRef.setInput('currentUserId', 'me');
    fixture.componentRef.setInput('messages', [
      { id: 10, text: 'Incoming', senderId: 'friend-id', sentAt: new Date() },
      { id: 11, text: 'Outgoing', senderId: 'me', sentAt: new Date() },
    ]);
    fixture.detectChanges();
    const messageList = fixture.nativeElement.querySelector('.message-list') as HTMLElement;
    vi.spyOn(messageList, 'getClientRects').mockReturnValue([{ } as DOMRect] as unknown as DOMRectList);
    expect(document.visibilityState).toBe('visible');
    expect(typeof IntersectionObserver).toBe('function');
    expect(messageList.getClientRects().length).toBe(1);
    document.dispatchEvent(new Event('visibilitychange'));

    const incoming = fixture.nativeElement.querySelector('[data-message-id="10"]') as HTMLElement;
    const outgoing = fixture.nativeElement.querySelector('[data-message-id="11"]') as HTMLElement;
    const observer = TestIntersectionObserver.instance;
    observer.trigger(incoming);
    observer.trigger(outgoing);
    observer.trigger(incoming);

    expect(readAcknowledgements).toEqual([{ conversationId: 42, lastReadMessageId: 10 }]);
    fixture.destroy();
    expect(observer.disconnected).toBe(true);
  });

  function getTextarea(): HTMLTextAreaElement {
    return fixture.nativeElement.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement;
  }

  function getSendButton(): HTMLButtonElement {
    return fixture.nativeElement.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
  }

  function setDraft(value: string): void {
    const textarea = getTextarea();
    textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
  }

  function enterMessage(textarea: HTMLTextAreaElement, value: string): void {
    setDraft(value);
    textarea.focus();
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);
    fixture.detectChanges();
    expect(event.defaultPrevented).toBe(true);
  }

  function completeSend(result: MessageSendResult): void {
    fixture.componentRef.setInput('sending', true);
    fixture.detectChanges();
    getTextarea().blur();
    fixture.componentRef.setInput('sendResult', result);
    fixture.componentRef.setInput('sending', false);
    fixture.detectChanges();
  }
});