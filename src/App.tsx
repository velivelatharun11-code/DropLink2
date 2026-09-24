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
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [isJoined, setIsJoined] = useState(false);

  // File Transfer State
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isTransferring, setIsTransferring] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<ProgressData | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<Array<{ id: string; name: string; size: number }>>([]);

  // Preview Modal State
  const [previewFile, setPreviewFile] = useState<PreviewableFile | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const rtcManagerRef = useRef<MeshWebRTCManager | null>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const hash = window.location.hash.replace('#', '');
    const currentRoom = hash || Math.random().toString(36).substring(2, 8);
    if (!hash) {
      window.location.hash = currentRoom;
    }
    setRoomId(currentRoom);

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

    rtc.onPeersUpdated = (peerIds) => {
      setConnectedPeers(peerIds);
    };

    rtc.onProgress = (prog) => {
      setUploadProgress(prog);
      if (prog.percentage >= 100) {
        setTimeout(() => {
          setIsTransferring(false);
          setUploadProgress(null);
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

  const handleJoinRoom = () => {
    if (rtcManagerRef.current && roomId) {
      setRoomError(null);
      rtcManagerRef.current.initRoom(roomId);
      setIsJoined(true);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
    }
  };

  const handleStartBroadcast = async () => {
    if (!selectedFile || !rtcManagerRef.current) return;
    try {
      setIsTransferring(true);
      await rtcManagerRef.current.streamFileToAllPeers(selectedFile);
    } catch (err: any) {
      setRoomError(err.message || 'File transfer failed');
      setIsTransferring(false);
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
            className="p-2 rounded-xl border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
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
            <button onClick={() => setRoomError(null)} className="font-bold ml-2">✕</button>
          </div>
        )}

        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <span className="text-xs uppercase font-bold tracking-wider text-slate-400">Current Room</span>
              <div className="text-xl font-mono font-bold text-indigo-600 dark:text-indigo-400">#{roomId}</div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Share this link or URL hash with up to 4 other devices to mesh connect.
              </p>
            </div>

            {!isJoined ? (
              <button
                onClick={handleJoinRoom}
                className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-xl shadow-md transition"
              >
                Join Room
              </button>
            ) : (
              <div className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 rounded-xl text-xs font-semibold">
                ✓ Joined Room
              </div>
            )}
          </div>
        </section>

        {uploadProgress && (
          <TransferProgress progress={uploadProgress} direction="upload" />
        )}

        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">Dispatch File to Mesh</h2>

          <div className="border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-xl p-8 text-center hover:border-indigo-500 transition-colors">
            <input
              type="file"
              id="file-input"
              className="hidden"
              onChange={handleFileChange}
              disabled={isTransferring}
            />
            <label htmlFor="file-input" className="cursor-pointer flex flex-col items-center space-y-2">
              <span className="text-3xl">📁</span>
              <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                {selectedFile ? selectedFile.name : 'Click or drop files to broadcast'}
              </span>
              <span className="text-xs text-slate-400">
                {selectedFile ? `${(selectedFile.size / (1024 * 1024)).toFixed(2)} MB` : 'Any format, direct zero-RAM disk slice'}
              </span>
            </label>
          </div>

          <div className="flex items-center justify-between pt-2">
            {selectedFile && (
              <button
                onClick={() => openPreview({ name: selectedFile.name, size: selectedFile.size, blob: selectedFile, type: selectedFile.type })}
                className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                Preview Selected File
              </button>
            )}

            <button
              onClick={handleStartBroadcast}
              disabled={!selectedFile || connectedPeers.length === 0 || isTransferring}
              className={`ml-auto px-6 py-2.5 rounded-xl text-sm font-semibold shadow-md transition ${
                !selectedFile || connectedPeers.length === 0 || isTransferring
                  ? 'bg-slate-200 dark:bg-slate-800 text-slate-400 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-700 text-white'
              }`}
            >
              {isTransferring ? 'Broadcasting...' : `Broadcast to ${connectedPeers.length} Peer(s)`}
            </button>
          </div>
        </section>

        {receivedFiles.length > 0 && (
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-3">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">Received Files (Direct to OPFS)</h2>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {receivedFiles.map((file) => (
                <div key={file.id} className="py-3 flex items-center justify-between">
                  <div className="truncate pr-4">
                    <div className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate">{file.name}</div>
                    <div className="text-xs text-slate-400">{(file.size / (1024 * 1024)).toFixed(2)} MB</div>
                  </div>
                  <button
                    onClick={() => openPreview({ name: file.name, size: file.size })}
                    className="px-3 py-1.5 text-xs font-semibold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition"
                  >
                    Inspect / Preview
                  </button>
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