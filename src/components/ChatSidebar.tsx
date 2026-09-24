import React, { useEffect, useRef, useState } from 'react';

export interface ChatMessage {
  id: string;
  text: string;
  senderId: string;
  timestamp: number;
  isSelf: boolean;
}

interface ChatSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  connectedPeersCount: number;
}

export const ChatSidebar: React.FC<ChatSidebarProps> = ({
  isOpen,
  onClose,
  messages,
  onSendMessage,
  connectedPeersCount
}) => {
  const [inputText, setInputText] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen]);

  const handleSend = () => {
    const trimmed = inputText.trim();
    if (!trimmed) return;
    onSendMessage(trimmed);
    setInputText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const copyMessageText = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  };

  if (!isOpen) return null;

  return (
    <aside
      className="fixed inset-y-0 right-0 z-50 w-full sm:w-96 bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col font-sans transition-all duration-300"
      aria-label="P2P Chat and Clipboard Sync"
    >
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50 dark:bg-slate-950">
        <div>
          <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <span>💬</span> P2P Chat & Clipboard
          </h2>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Control channel sync • {connectedPeersCount} Peer(s)
          </p>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-800 transition cursor-pointer"
          aria-label="Close chat"
        >
          ✕
        </button>
      </div>

      {/* Messages Stream */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50/50 dark:bg-slate-950/40">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-6 space-y-2 text-slate-400 dark:text-slate-500">
            <span className="text-3xl">📋</span>
            <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">
              No messages or clipboard items yet.
            </p>
            <p className="text-[11px] max-w-xs">
              Type text or paste clipboard snippets to synchronize in real-time across all connected mesh peers.
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col ${msg.isSelf ? 'items-end' : 'items-start'} group`}
            >
              <div className="flex items-center gap-1.5 mb-1 px-1">
                <span className="text-[10px] font-mono font-medium text-slate-400">
                  {msg.isSelf ? 'You' : `Peer ${msg.senderId.slice(0, 6)}`}
                </span>
                <span className="text-[10px] text-slate-400">
                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>

              <div
                className={`relative max-w-[85%] rounded-2xl px-3.5 py-2 text-xs shadow-sm break-words ${
                  msg.isSelf
                    ? 'bg-indigo-600 text-white rounded-br-xs'
                    : 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700 rounded-bl-xs'
                }`}
              >
                <div className="whitespace-pre-wrap">{msg.text}</div>

                <div className="mt-1.5 pt-1 border-t border-white/20 dark:border-slate-700/60 flex items-center justify-between text-[10px]">
                  <button
                    type="button"
                    onClick={() => copyMessageText(msg.id, msg.text)}
                    className={`font-semibold transition hover:underline cursor-pointer flex items-center gap-1 ${
                      msg.isSelf ? 'text-indigo-200 hover:text-white' : 'text-indigo-600 dark:text-indigo-400'
                    }`}
                  >
                    {copiedId === msg.id ? '✓ Copied' : '📋 Copy Text'}
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Bar */}
      <div className="p-3 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center gap-2">
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type message or paste text..."
          className="flex-1 px-3.5 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition font-sans"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!inputText.trim()}
          className={`px-4 py-2 rounded-xl text-xs font-semibold shadow transition cursor-pointer ${
            !inputText.trim()
              ? 'bg-slate-200 dark:bg-slate-800 text-slate-400 cursor-not-allowed'
              : 'bg-indigo-600 hover:bg-indigo-700 text-white'
          }`}
        >
          Send
        </button>
      </div>
    </aside>
  );
};
