import React, { useState } from 'react';

interface RoomGateProps {
  initialRoomId: string;
  onJoinRoom: (roomId: string, password?: string) => void;
  error: string | null;
  onClearError: () => void;
  isProtected?: boolean;
}

export const RoomGateModal: React.FC<RoomGateProps> = ({
  initialRoomId,
  onJoinRoom,
  error,
  onClearError,
  isProtected = false
}) => {
  const [roomId, setRoomId] = useState(initialRoomId || '');
  const [password, setPassword] = useState('');
  const [isCustomMode, setIsCustomMode] = useState(!initialRoomId);

  const handleRandomRoom = () => {
    const random = Math.random().toString(36).substring(2, 8);
    setRoomId(random);
    onClearError();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanRoomId = roomId.trim().replace(/^#/, '');
    if (!cleanRoomId) return;
    onJoinRoom(cleanRoomId, password.trim() || undefined);
  };

  return (
    <div className="w-full max-w-md mx-auto my-8 p-6 sm:p-8 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl shadow-xl transition-all">
      <div className="text-center space-y-2 mb-6">
        <div className="w-12 h-12 mx-auto rounded-2xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800 flex items-center justify-center text-2xl">
          {isProtected || password ? '🔒' : '🌐'}
        </div>
        <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 tracking-tight">
          {initialRoomId && !isCustomMode
            ? `Enter Mesh Room #${initialRoomId}`
            : 'Create or Join Mesh Room'}
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xs mx-auto">
          {initialRoomId && !isCustomMode
            ? isProtected
              ? 'This room is password-protected. Enter the matching password to join.'
              : 'Enter room password if protected, or join directly.'
            : 'Share zero-RAM direct streaming with up to 4 peers in a WebRTC mesh.'}
        </p>
      </div>

      {error && (
        <div className="mb-5 p-3.5 rounded-xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 text-xs flex items-center justify-between">
          <span className="font-medium flex items-center gap-1.5">
            <span>⚠️</span> {error}
          </span>
          <button
            type="button"
            onClick={onClearError}
            className="text-red-500 hover:text-red-700 font-bold ml-2 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Room ID Input */}
        <div>
          <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">
            Room Identifier
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400 font-mono text-sm">#</span>
              <input
                type="text"
                value={roomId}
                onChange={(e) => {
                  setRoomId(e.target.value);
                  onClearError();
                }}
                placeholder="e.g. y3heon"
                required
                className="w-full pl-8 pr-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-mono text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition"
              />
            </div>
            <button
              type="button"
              onClick={handleRandomRoom}
              className="px-3 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-xl border border-slate-200 dark:border-slate-700 transition cursor-pointer"
              title="Generate fresh random room"
            >
              🎲 Random
            </button>
          </div>
        </div>

        {/* Room Password Input */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Room Password {isProtected ? '(Required)' : '(Optional)'}
            </label>
            <span className="text-[10px] text-slate-400">
              {password ? 'AES-256-GCM E2EE Enabled' : 'Leave empty if open'}
            </span>
          </div>
          <div className="relative">
            <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400 text-xs">🔒</span>
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                onClearError();
              }}
              placeholder={isProtected ? 'Enter Room Password...' : 'Room Password (Optional E2EE)...'}
              autoFocus={Boolean(initialRoomId && isProtected)}
              className="w-full pl-8 pr-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition font-sans"
            />
          </div>
        </div>

        {/* Action Button */}
        <button
          type="submit"
          disabled={!roomId.trim()}
          className={`w-full py-2.5 px-4 rounded-xl text-sm font-semibold shadow-md transition cursor-pointer flex items-center justify-center gap-2 ${
            !roomId.trim()
              ? 'bg-slate-200 dark:bg-slate-800 text-slate-400 cursor-not-allowed'
              : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-500/20'
          }`}
        >
          <span>{isProtected || password ? '🔒' : '🚀'}</span>
          <span>{initialRoomId && !isCustomMode ? 'Join Room' : 'Enter Room'}</span>
        </button>

        {/* Mode Toggle */}
        {initialRoomId && !isCustomMode && (
          <div className="pt-2 text-center">
            <button
              type="button"
              onClick={() => {
                setIsCustomMode(true);
                handleRandomRoom();
              }}
              className="text-xs text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 underline transition cursor-pointer"
            >
              Want to create a different room instead?
            </button>
          </div>
        )}
      </form>
    </div>
  );
};
