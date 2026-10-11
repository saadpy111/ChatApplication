import { TestBed } from '@angular/core/testing';
import { ChatConversationComponent } from './chat-conversation.component';
import { MessageSendRequest, MessageSendResult } from '../../models/chat-message.model';

describe('ChatConversationComponent composer', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<ChatConversationComponent>>;
  let component: ChatConversationComponent;
  let sentRequests: MessageSendRequest[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ChatConversationComponent] }).compileComponents();
    fixture = TestBed.createComponent(ChatConversationComponent);
    component = fixture.componentInstance;
    sentRequests = [];
    component.messageSubmitted.subscribe((request) => sentRequests.push(request));
    fixture.componentRef.setInput('friend', { userId: 'friend-id', username: 'Morgan' });
    fixture.componentRef.setInput('conversationId', 42);
    fixture.componentRef.setInput('connectionStatus', 'connected');
    fixture.detectChanges();
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