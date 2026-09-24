import React, { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { MeshWebRTCManager, type TransferProgress as ProgressData } from './core/webrtc';
import { FilePreviewModal, type PreviewableFile } from './components/FilePreviewModal';
import { TransferProgress } from './components/TransferProgress';
import { ThemeProvider, useTheme } from './context/ThemeContext';

function MainApp() {
  const { theme, toggleTheme } = useTheme();

  // Room & Peer State
  const [roomId, setRoomId] = useState<string>('');
  const [inputRoomId, setInputRoomId] = useState<string>('');
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [isJoined, setIsJoined] = useState(false);
  const [copied, setCopied] = useState(false);

  // File Transfer State
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isTransferring, setIsTransferring] = useState(false);
  const [currentBroadcastIndex, setCurrentBroadcastIndex] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<ProgressData | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<Array<{ id: string; name: string; size: number }>>([]);

  // Preview Modal State
  const [previewFile, setPreviewFile] = useState<PreviewableFile | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const rtcManagerRef = useRef<MeshWebRTCManager | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const hash = window.location.hash.replace('#', '');
    const currentRoom = hash || Math.random().toString(36).substring(2, 8);
    if (!hash) {
      window.location.hash = currentRoom;
    }
    setRoomId(currentRoom);
    setInputRoomId(currentRoom);

    try {
      workerRef.current = new Worker(
        new URL('./workers/opfs.worker.ts', import.meta.url),
        { type: 'module' }
      );
    } catch (e) {
      console.warn('OPFS Worker initialization fallback:', e);
    }

    const socket = io({
      transports: ['polling', 'websocket'],
      reconnectionAttempts: 5
    });
    socketRef.current = socket;

    const rtc = new MeshWebRTCManager(socket, workerRef.current || undefined);
    rtcManagerRef.current = rtc;
    rtc.initRoom(currentRoom);
    setIsJoined(true);

    rtc.onPeersUpdated = (peerIds) => {
      setConnectedPeers(peerIds);
    };

    rtc.onProgress = (prog) => {
      setUploadProgress(prog);
      if (prog.percentage >= 100) {
        setTimeout(() => {
          setUploadProgress((current) => (current?.percentage === 100 ? null : current));
        }, 1500);
      }
    };

    rtc.onFileReceived = (fileMeta) => {
      setReceivedFiles((prev) => [fileMeta, ...prev]);
    };

    rtc.onError = (err) => {
      setRoomError(err);
    };

    return () => {
      rtc.destroy();
      socket.disconnect();
      if (workerRef.current) {
        workerRef.current.terminate();
      }
    };
  }, []);

  // Listen for hash changes in URL (e.g. browser navigation or paste)
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.replace('#', '');
      if (hash && hash !== roomId) {
        setInputRoomId(hash);
        setRoomId(hash);
        if (rtcManagerRef.current) {
          rtcManagerRef.current.initRoom(hash);
          setIsJoined(true);
        }
      }
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [roomId]);

  const handleJoinRoom = (targetId?: string) => {
    const roomToJoin = (targetId ?? inputRoomId).trim().replace(/^#/, '');
    if (!roomToJoin) return;
    setRoomError(null);
    setRoomId(roomToJoin);
    setInputRoomId(roomToJoin);
    window.location.hash = roomToJoin;
    if (rtcManagerRef.current) {
      rtcManagerRef.current.initRoom(roomToJoin);
      setIsJoined(true);
    }
  };

  const handleNewRoom = () => {
    const newRoom = Math.random().toString(36).substring(2, 8);
    setRoomError(null);
    setInputRoomId(newRoom);
    setRoomId(newRoom);
    window.location.hash = newRoom;
    if (rtcManagerRef.current) {
      rtcManagerRef.current.initRoom(newRoom);
      setIsJoined(true);
    }
  };

  const handleCopyLink = async () => {
    const activeRoom = roomId || inputRoomId.trim().replace(/^#/, '');
    const url = `${window.location.origin}#${activeRoom}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy link:', err);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFiles(Array.from(e.target.files));
    }
    e.target.value = '';
  };

  const handleFolderInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFiles(Array.from(e.target.files));
    }
    e.target.value = '';
  };

  const handleStartBroadcast = async () => {
    if (selectedFiles.length === 0 || !rtcManagerRef.current) return;
    try {
      setIsTransferring(true);
      setRoomError(null);
      for (let i = 0; i < selectedFiles.length; i++) {
        setCurrentBroadcastIndex(i);
        const file = selectedFiles[i];
        await rtcManagerRef.current.streamFileToAllPeers(file);
      }
    } catch (err: any) {
      setRoomError(err.message || 'File transfer failed');
    } finally {
      setIsTransferring(false);
      setCurrentBroadcastIndex(0);
    }
  };

  const handleDownload = async (fileName: string) => {
    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error('Failed to download file from OPFS:', err);
      setRoomError(err.message || `Failed to download "${fileName}"`);
    }
  };

  const handlePreviewReceivedFile = async (file: { id: string; name: string; size: number }) => {
    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(file.name);
      const fileBlob = await fileHandle.getFile();
      openPreview({
        name: file.name,
        size: file.size || fileBlob.size,
        blob: fileBlob,
        type: fileBlob.type,
      });
    } catch (err: any) {
      console.warn('Failed to read file from OPFS for preview:', err);
      openPreview({
        name: file.name,
        size: file.size,
      });
    }
  };

  const openPreview = (file: PreviewableFile) => {
    setPreviewFile(file);
    setIsPreviewOpen(true);
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col font-sans transition-colors duration-200">
      {/* Header */}
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur px-6 py-4 sticky top-0 z-40 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-black text-sm shadow">
            DL
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight">DropLink2</h1>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">Zero-RAM 5-Peer Mesh</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="px-3 py-1 rounded-full text-xs font-semibold border flex items-center gap-1.5 border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800/60">
            <span
              className={`w-2 h-2 rounded-full ${
                connectedPeers.length > 0 ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'
              }`}
            />
            <span>{connectedPeers.length}/5 Peers</span>
          </div>

          <button
            onClick={toggleTheme}
            className="p-2 rounded-xl border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-4xl w-full mx-auto p-6 space-y-6">
        {roomError && (
          <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 text-sm flex items-center justify-between">
            <span>{roomError}</span>
            <button onClick={() => setRoomError(null)} className="font-bold ml-2 cursor-pointer">✕</button>
          </div>
        )}

        {/* Room Control Bar */}
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <span className="text-xs uppercase font-bold tracking-wider text-slate-400">Mesh Room</span>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xl font-mono font-bold text-indigo-600 dark:text-indigo-400">
                  #{roomId || '------'}
                </span>
                {isJoined ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 rounded-full text-[11px] font-semibold">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    Joined
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800 rounded-full text-[11px] font-semibold">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                    Not Joined
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Share this link or URL hash with up to 4 other devices to mesh connect.
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={handleCopyLink}
                className="px-3.5 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-xl border border-slate-200 dark:border-slate-700 transition cursor-pointer"
                title="Copy direct room link to clipboard"
              >
                {copied ? '✓ Copied Link' : 'Copy Link'}
              </button>

              <button
                type="button"
                onClick={handleNewRoom}
                className="px-3.5 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-xl border border-slate-200 dark:border-slate-700 transition cursor-pointer"
                title="Generate fresh random room"
              >
                New Room
              </button>
            </div>
          </div>

          {/* Interactive Room Input Bar */}
          <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <div className="relative flex-1">
              <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400 font-mono text-sm">#</span>
              <input
                type="text"
                value={inputRoomId}
                onChange={(e) => setInputRoomId(e.target.value.trim())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleJoinRoom();
                }}
                placeholder="Type or paste room ID (e.g. y3heon)"
                className="w-full pl-8 pr-4 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-mono text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition"
              />
            </div>
            <button
              type="button"
              onClick={() => handleJoinRoom()}
              disabled={!inputRoomId.trim()}
              className={`px-6 py-2 text-sm font-semibold rounded-xl shadow-sm transition cursor-pointer ${
                !inputRoomId.trim()
                  ? 'bg-slate-200 dark:bg-slate-800 text-slate-400 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-700 text-white'
              }`}
            >
              {isJoined && inputRoomId.trim().replace(/^#/, '') === roomId ? 'Re-Join' : 'Join Room'}
            </button>
          </div>
        </section>

        {uploadProgress && (
          <TransferProgress progress={uploadProgress} direction="upload" />
        )}

        {/* Dispatch File Section */}
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">Dispatch Files to Mesh</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isTransferring}
                className="px-3.5 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-xl border border-slate-200 dark:border-slate-700 transition cursor-pointer"
              >
                Select Files
              </button>
              <button
                type="button"
                onClick={() => folderInputRef.current?.click()}
                disabled={isTransferring}
                className="px-3.5 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-xl border border-slate-200 dark:border-slate-700 transition cursor-pointer"
              >
                Select Folder
              </button>
            </div>
          </div>

          {/* Hidden inputs */}
          <input
            ref={fileInputRef}
            type="file"
            id="file-input"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
            disabled={isTransferring}
          />
          <input
            ref={folderInputRef}
            type="file"
            id="folder-input"
            className="hidden"
            {...({ webkitdirectory: '', directory: '' } as any)}
            onChange={handleFolderInputChange}
            disabled={isTransferring}
          />

          {/* Dropzone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                setSelectedFiles(Array.from(e.dataTransfer.files));
              }
            }}
            className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer ${
              isDragging
                ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/30'
                : 'border-slate-300 dark:border-slate-700 hover:border-indigo-500'
            }`}
            onClick={() => {
              if (selectedFiles.length === 0) fileInputRef.current?.click();
            }}
          >
            <div className="flex flex-col items-center space-y-2">
              <span className="text-3xl">📁</span>
              {selectedFiles.length === 0 ? (
                <>
                  <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                    Click "Select Files", "Select Folder", or drop files/folders here
                  </span>
                  <span className="text-xs text-slate-400">
                    Any format, zero-RAM chunked disk slice
                  </span>
                </>
              ) : selectedFiles.length === 1 ? (
                <>
                  <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                    {selectedFiles[0].name}
                  </span>
                  <span className="text-xs text-slate-400">
                    {(selectedFiles[0].size / (1024 * 1024)).toFixed(2)} MB
                  </span>
                </>
              ) : (
                <>
                  <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                    {selectedFiles.length} files selected
                  </span>
                  <span className="text-xs text-slate-400">
                    Total: {(selectedFiles.reduce((acc, f) => acc + f.size, 0) / (1024 * 1024)).toFixed(2)} MB
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Selected Files List (if > 1 file selected) */}
          {selectedFiles.length > 1 && (
            <div className="max-h-40 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 rounded-xl border border-slate-200 dark:border-slate-800 p-2 text-xs">
              {selectedFiles.map((file, idx) => (
                <div key={idx} className="py-1.5 px-2 flex items-center justify-between">
                  <div className="truncate flex-1 pr-2">
                    <span className="font-medium text-slate-800 dark:text-slate-200">{file.name}</span>
                    <span className="ml-2 text-slate-400">({(file.size / (1024 * 1024)).toFixed(2)} MB)</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => openPreview({ name: file.name, size: file.size, blob: file, type: file.type })}
                    className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline flex-shrink-0 cursor-pointer"
                  >
                    Preview
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Action Row */}
          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-3">
              {selectedFiles.length === 1 && (
                <button
                  type="button"
                  onClick={() => openPreview({
                    name: selectedFiles[0].name,
                    size: selectedFiles[0].size,
                    blob: selectedFiles[0],
                    type: selectedFiles[0].type
                  })}
                  className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                >
                  Preview Selected File
                </button>
              )}
              {selectedFiles.length > 0 && !isTransferring && (
                <button
                  type="button"
                  onClick={() => setSelectedFiles([])}
                  className="text-xs font-semibold text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer"
                >
                  Clear Selection
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={handleStartBroadcast}
              disabled={selectedFiles.length === 0 || connectedPeers.length === 0 || isTransferring}
              className={`ml-auto px-6 py-2.5 rounded-xl text-sm font-semibold shadow-md transition ${
                selectedFiles.length === 0 || connectedPeers.length === 0 || isTransferring
                  ? 'bg-slate-200 dark:bg-slate-800 text-slate-400 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer'
              }`}
            >
              {isTransferring
                ? selectedFiles.length > 1
                  ? `Broadcasting (${currentBroadcastIndex + 1}/${selectedFiles.length})...`
                  : 'Broadcasting...'
                : selectedFiles.length > 1
                ? `Broadcast ${selectedFiles.length} Files to ${connectedPeers.length} Peer(s)`
                : `Broadcast to ${connectedPeers.length} Peer(s)`}
            </button>
          </div>
        </section>

        {/* Received Files List */}
        {receivedFiles.length > 0 && (
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-3">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">Received Files (Direct to OPFS)</h2>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {receivedFiles.map((file) => (
                <div key={file.id} className="py-3 flex items-center justify-between gap-4">
                  <div className="truncate flex-1">
                    <div className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate">{file.name}</div>
                    <div className="text-xs text-slate-400">{(file.size / (1024 * 1024)).toFixed(2)} MB</div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => handlePreviewReceivedFile(file)}
                      className="px-3 py-1.5 text-xs font-semibold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-lg transition cursor-pointer"
                    >
                      Inspect / Preview
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDownload(file.name)}
                      className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg shadow-sm transition cursor-pointer"
                    >
                      Download
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      <FilePreviewModal
        file={previewFile}
        isOpen={isPreviewOpen}
        onClose={() => setIsPreviewOpen(false)}
      />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <MainApp />
    </ThemeProvider>
  );
}