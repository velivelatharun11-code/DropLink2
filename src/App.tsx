import React, { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { MeshWebRTCManager, type TransferProgress as ProgressData, type PeerDiagnosticInfo } from './core/webrtc';
import { FilePreviewModal, type PreviewableFile } from './components/FilePreviewModal';
import { QRCodeModal } from './components/QRCodeModal';
import { ChatSidebar, type ChatMessage } from './components/ChatSidebar';
import { RoomGateModal } from './components/RoomGateModal';
import { TransferProgress } from './components/TransferProgress';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { deriveRoomKey } from './core/crypto';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export interface ReceivedFileItem {
  id: string;
  name: string;
  sanitizedName?: string;
  size: number;
  mimeType?: string;
}

function MainApp() {
  const { theme, toggleTheme } = useTheme();

  // Room & Gatekeeper State
  const [roomId, setRoomId] = useState<string>(() => {
    return window.location.hash.replace('#', '') || '';
  });
  const [roomPassword, setRoomPassword] = useState<string>('');
  const [isJoined, setIsJoined] = useState(false);
  const [isRoomProtected, setIsRoomProtected] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [peerDiagnostics, setPeerDiagnostics] = useState<PeerDiagnosticInfo[]>([]);
  const [occupancy, setOccupancy] = useState<number>(1);
  const [transferLock, setTransferLock] = useState<{
    isLocked: boolean;
    senderId: string | null;
    senderName: string | null;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // File Transfer State
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isTransferring, setIsTransferring] = useState(false);
  const [currentBroadcastIndex, setCurrentBroadcastIndex] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<ProgressData | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFileItem[]>([]);

  // Preview & QR Modal State
  const [previewFile, setPreviewFile] = useState<PreviewableFile | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isQRModalOpen, setIsQRModalOpen] = useState(false);

  // Chat State
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [unreadChatCount, setUnreadChatCount] = useState(0);

  // PWA Install State
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [canInstall, setCanInstall] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const rtcManagerRef = useRef<MeshWebRTCManager | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Initialize OPFS Worker
    try {
      const worker = new Worker(
        new URL('./workers/opfs.worker.ts', import.meta.url),
        { type: 'module' }
      );

      worker.onmessage = (e: MessageEvent) => {
        const data = e.data || {};
        if (data.type === 'TRANSFER_COMPLETE' || data.type === 'FILE_COMPLETE') {
          const item: ReceivedFileItem = {
            id: data.fileId || `file-${Date.now()}`,
            name: data.originalName || data.fileName,
            sanitizedName: data.fileName,
            size: data.size || 0,
            mimeType: data.mimeType || 'application/octet-stream',
          };
          setReceivedFiles((prev) => [item, ...prev.filter((f) => f.id !== item.id)]);
        } else if (data.type === 'ERROR') {
          console.error('[OPFS Worker Error]:', data.error);
        }
      };

      workerRef.current = worker;
    } catch (e) {
      console.warn('OPFS Worker initialization fallback:', e);
    }

    // Connect to Signaling Server
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

    rtc.onPeerConnected = () => {
      if (rtcManagerRef.current) {
        setConnectedPeers(rtcManagerRef.current.getConnectedPeerIds());
      }
    };

    rtc.onPeerDisconnected = () => {
      if (rtcManagerRef.current) {
        setConnectedPeers(rtcManagerRef.current.getConnectedPeerIds());
      }
    };

    rtc.onPeerDiagnosticsUpdated = (diagnostics) => {
      setPeerDiagnostics(diagnostics);
    };

    rtc.onRoomJoined = ({ roomId: joinedRoom, isProtected, occupancy: occ, transferLock: lock }) => {
      setIsJoined(true);
      setIsRoomProtected(isProtected);
      setGateError(null);
      setRoomError(null);
      setRoomId(joinedRoom);
      if (typeof occ === 'number') {
        setOccupancy(occ);
      }
      if (lock && lock.isLocked) {
        setTransferLock(lock);
      } else {
        setTransferLock(null);
      }
      window.location.hash = joinedRoom;
    };

    rtc.onPeerJoined = (data) => {
      if (typeof data.occupancy === 'number') {
        setOccupancy(data.occupancy);
      }
      if (data.transferLock) {
        setTransferLock(data.transferLock.isLocked ? data.transferLock : null);
      }
    };

    rtc.onPeerLeft = (data) => {
      if (typeof data.occupancy === 'number') {
        setOccupancy(data.occupancy);
      }
    };

    rtc.onOccupancyUpdated = (data) => {
      if (typeof data.occupancy === 'number') {
        setOccupancy(data.occupancy);
      }
    };

    rtc.onTransferLockAcquired = (data) => {
      setTransferLock({
        isLocked: true,
        senderId: data.senderId,
        senderName: data.senderName
      });
    };

    rtc.onTransferLockReleased = () => {
      setTransferLock(null);
    };

    rtc.onAuthRequired = (data) => {
      setIsJoined(false);
      setIsRoomProtected(true);
      setGateError(data.message || 'Room is protected: password required.');
    };

    rtc.onAuthFailed = (data) => {
      setIsJoined(false);
      setIsRoomProtected(true);
      setGateError(data.message || 'Incorrect room password. Access denied.');
    };

    rtc.onProgress = (prog) => {
      setUploadProgress(prog);
      if (prog.percentage >= 100) {
        setTimeout(() => {
          setUploadProgress((current) => (current?.percentage === 100 ? null : current));
        }, 1500);
      }
    };

    rtc.onChatMessage = (msg) => {
      setChatMessages((prev) => [...prev, { ...msg, isSelf: false }]);
      setIsChatOpen((currentOpen) => {
        if (!currentOpen) {
          setUnreadChatCount((count) => count + 1);
        }
        return currentOpen;
      });
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

  // Listen for hash changes in URL (e.g. user clicks a link or changes hash)
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.replace('#', '');
      if (hash && hash !== roomId) {
        setRoomId(hash);
        setIsJoined(false);
        setGateError(null);
        if (rtcManagerRef.current) {
          rtcManagerRef.current.leaveRoom();
        }
      }
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [roomId]);

  // Handle Room Password / E2EE Key derivation when inside a room
  useEffect(() => {
    let isCancelled = false;
    if (!roomPassword || !roomId || !isJoined) {
      rtcManagerRef.current?.setEncryptionKey(null);
      return;
    }

    deriveRoomKey(roomPassword, roomId)
      .then((key) => {
        if (!isCancelled) {
          rtcManagerRef.current?.setEncryptionKey(key);
        }
      })
      .catch((err) => {
        console.error('Failed to derive encryption key:', err);
      });

    return () => {
      isCancelled = true;
    };
  }, [roomPassword, roomId, isJoined]);

  // Capture PWA beforeinstallprompt event
  useEffect(() => {
    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setCanInstall(true);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
  }, []);

  const handleInstallApp = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setCanInstall(false);
    }
    setDeferredPrompt(null);
  };

  const handleJoinRoom = (targetRoomId: string, password?: string) => {
    const cleanRoomId = targetRoomId.trim().replace(/^#/, '');
    if (!cleanRoomId) return;

    setGateError(null);
    setRoomError(null);
    setRoomId(cleanRoomId);
    setRoomPassword(password || '');

    if (rtcManagerRef.current) {
      rtcManagerRef.current.initRoom(cleanRoomId, password);
    }
  };

  const isLockedByOther = !!(transferLock?.isLocked && transferLock.senderId !== socketRef.current?.id);

  const handleLeaveRoom = () => {
    if (rtcManagerRef.current) {
      rtcManagerRef.current.leaveRoom();
    }
    setIsJoined(false);
    setRoomId('');
    setRoomPassword('');
    setIsRoomProtected(false);
    setConnectedPeers([]);
    setPeerDiagnostics([]);
    setOccupancy(1);
    setTransferLock(null);
    setSelectedFiles([]);
    setIsTransferring(false);
    setGateError(null);
    window.location.hash = '';
  };

  const handleCopyLink = async () => {
    const url = `${window.location.origin}#${roomId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy link:', err);
    }
  };

  const handleSendChatMessage = (text: string) => {
    if (!rtcManagerRef.current) return;
    const sentMsg = rtcManagerRef.current.sendChatMessage(text);
    setChatMessages((prev) => [...prev, { ...sentMsg, isSelf: true }]);
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
    if (occupancy < 2 || isLockedByOther) return;

    // 1. Acquire mutual exclusion transfer lock from signaling server
    const lockRes = await rtcManagerRef.current.acquireTransferLock();
    if (!lockRes.success) {
      setRoomError(lockRes.error || 'Transmission is locked by another peer.');
      return;
    }

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
      // 2. Release mutual exclusion transfer lock
      try {
        await rtcManagerRef.current.releaseTransferLock();
      } catch (e) {
        console.error('Error releasing transfer lock:', e);
      }
    }
  };

  const handleDownload = async (fileItem: ReceivedFileItem) => {
    try {
      const root = await navigator.storage.getDirectory();
      const sanitized = fileItem.sanitizedName || fileItem.name.replace(/[/\\]+/g, '__');
      const handle = await root.getFileHandle(sanitized);
      const file = await handle.getFile();
      const blob = new Blob([await file.arrayBuffer()], {
        type: fileItem.mimeType || file.type || 'application/octet-stream'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileItem.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err: any) {
      console.error('Download error:', err);
      setRoomError('Unable to retrieve file from local storage. Please try again.');
    }
  };

  const handlePreviewReceivedFile = async (fileItem: ReceivedFileItem) => {
    try {
      const root = await navigator.storage.getDirectory();
      const sanitized = fileItem.sanitizedName || fileItem.name.replace(/[/\\]+/g, '__');
      const handle = await root.getFileHandle(sanitized);
      const file = await handle.getFile();
      const blob = new Blob([await file.arrayBuffer()], {
        type: fileItem.mimeType || file.type || 'application/octet-stream'
      });
      openPreview({
        name: fileItem.name,
        size: fileItem.size || blob.size,
        blob: blob,
        type: blob.type,
      });
    } catch (err: any) {
      console.warn('Failed to retrieve file from OPFS for preview:', err);
      openPreview({
        name: fileItem.name,
        size: fileItem.size,
        type: fileItem.mimeType,
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

        <div className="flex items-center gap-2.5">
          {/* PWA Install Button */}
          {canInstall && (
            <button
              onClick={handleInstallApp}
              className="px-3 py-1.5 rounded-xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/50 hover:bg-indigo-100 dark:hover:bg-indigo-900 text-indigo-700 dark:text-indigo-300 text-xs font-semibold transition cursor-pointer flex items-center gap-1.5 shadow-sm"
              title="Install DropLink2 Progressive Web App"
            >
              <span>⬇</span>
              <span className="hidden sm:inline">Install App</span>
            </button>
          )}

          {/* Chat Toggle Button (Only active when in room) */}
          {isJoined && (
            <button
              onClick={() => {
                setIsChatOpen((prev) => !prev);
                setUnreadChatCount(0);
              }}
              className="relative px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer flex items-center gap-1.5 text-xs font-semibold"
              aria-label="Toggle P2P Chat"
            >
              <span>💬</span>
              <span className="hidden sm:inline">Chat</span>
              {unreadChatCount > 0 && (
                <span className="absolute -top-1 -right-1 px-1.5 py-0.5 text-[10px] font-bold bg-indigo-600 text-white rounded-full leading-none animate-pulse">
                  {unreadChatCount}
                </span>
              )}
            </button>
          )}

          {/* Peer / Participant Count Badge */}
          {isJoined && (
            <div className="px-3 py-1.5 rounded-full text-xs font-semibold border flex items-center gap-1.5 border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800/60 shadow-sm">
              <span
                className={`w-2 h-2 rounded-full ${
                  occupancy >= 2 ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'
                }`}
              />
              <span className="font-medium">
                {occupancy === 1
                  ? '1/5 in Room (Waiting for receivers)'
                  : occupancy >= 5
                  ? '5/5 in Room (Full)'
                  : `${occupancy}/5 in Room`}
              </span>
            </div>
          )}

          {/* Theme Toggle */}
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

        {/* 1. ROOM GATEKEEPER (Shown when user is not inside a room) */}
        {!isJoined && (
          <RoomGateModal
            initialRoomId={roomId}
            onJoinRoom={handleJoinRoom}
            error={gateError}
            onClearError={() => setGateError(null)}
            isProtected={isRoomProtected}
          />
        )}

        {/* 2. ACTIVE MESH DASHBOARD (Shown only after user successfully enters room) */}
        {isJoined && (
          <>
            {/* Room Info Bar */}
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <span className="text-xs uppercase font-bold tracking-wider text-slate-400">Connected Room</span>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xl font-mono font-bold text-indigo-600 dark:text-indigo-400">
                      #{roomId}
                    </span>
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 rounded-full text-[11px] font-semibold">
                      <span className={`w-1.5 h-1.5 rounded-full ${occupancy >= 2 ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
                      {occupancy >= 2 ? `Active Mesh (${occupancy}/5)` : 'Waiting for receivers (1/5)'}
                    </span>
                    {roomPassword && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 rounded-full text-[11px] font-semibold">
                        <span>🔒</span> AES-256-GCM E2EE
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Share this link or QR code with up to 4 other devices to mesh connect.
                  </p>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => setIsQRModalOpen(true)}
                    className="px-3.5 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-xl border border-slate-200 dark:border-slate-700 transition cursor-pointer flex items-center gap-1.5"
                    title="Show Room QR Code"
                  >
                    <span>📱</span> Show QR
                  </button>

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
                    onClick={handleLeaveRoom}
                    className="px-3.5 py-2 bg-red-50 dark:bg-red-950/40 hover:bg-red-100 dark:hover:bg-red-900/40 text-red-700 dark:text-red-300 text-xs font-semibold rounded-xl border border-red-200 dark:border-red-800 transition cursor-pointer"
                    title="Leave active room"
                  >
                    Leave Room
                  </button>
                </div>
              </div>
            </section>

            {/* Real-Time Mesh Diagnostics UI */}
            {peerDiagnostics.length > 0 && (
              <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-sm space-y-2.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                    <span>⚡</span> P2P Mesh Diagnostics
                  </h3>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    {connectedPeers.length}/{peerDiagnostics.length} Connected Peer(s)
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {peerDiagnostics.map((peer) => (
                    <div
                      key={peer.peerId}
                      className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="truncate min-w-0">
                        <div className="font-semibold text-slate-800 dark:text-slate-200 truncate">
                          {peer.peerName || `Peer #${peer.peerId.slice(0, 5)}`}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1.5 mt-0.5">
                          {peer.status === 'connected' ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                              Connected ({peer.openChannelsCount}/5 Channels Open)
                            </span>
                          ) : peer.status === 'failed' ? (
                            <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400 font-medium">
                              <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                              Failed / NAT Blocked
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                              Connecting (ICE checking)
                            </span>
                          )}
                        </div>
                      </div>

                      {peer.status === 'failed' && (
                        <button
                          type="button"
                          onClick={() => rtcManagerRef.current?.retryPeer(peer.peerId)}
                          className="px-2.5 py-1 rounded-lg bg-red-100 hover:bg-red-200 dark:bg-red-950/70 dark:hover:bg-red-900/60 text-red-700 dark:text-red-300 text-[11px] font-semibold transition cursor-pointer flex-shrink-0"
                          title="Retry WebRTC & ICE connection"
                        >
                          Retry Connection
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {uploadProgress && (
              <TransferProgress progress={uploadProgress} direction={isTransferring ? "upload" : "download"} />
            )}

            {/* Dispatch File Section */}
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400">Dispatch Files to Mesh</h2>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isTransferring || isLockedByOther}
                    className={`px-3.5 py-1.5 rounded-xl border text-xs font-semibold transition ${
                      isTransferring || isLockedByOther
                        ? 'bg-slate-100 dark:bg-slate-800/40 text-slate-400 border-slate-200 dark:border-slate-800 cursor-not-allowed'
                        : 'bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700 cursor-pointer'
                    }`}
                  >
                    Select Files
                  </button>
                  <button
                    type="button"
                    onClick={() => folderInputRef.current?.click()}
                    disabled={isTransferring || isLockedByOther}
                    className={`px-3.5 py-1.5 rounded-xl border text-xs font-semibold transition ${
                      isTransferring || isLockedByOther
                        ? 'bg-slate-100 dark:bg-slate-800/40 text-slate-400 border-slate-200 dark:border-slate-800 cursor-not-allowed'
                        : 'bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700 cursor-pointer'
                    }`}
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
                disabled={isTransferring || isLockedByOther}
              />
              <input
                ref={folderInputRef}
                type="file"
                id="folder-input"
                className="hidden"
                {...({ webkitdirectory: '', directory: '' } as any)}
                onChange={handleFolderInputChange}
                disabled={isTransferring || isLockedByOther}
              />

              {/* Dropzone */}
              <div
                onDragOver={(e) => {
                  if (isLockedByOther) return;
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  if (isLockedByOther) return;
                  e.preventDefault();
                  setIsDragging(false);
                  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    setSelectedFiles(Array.from(e.dataTransfer.files));
                  }
                }}
                className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
                  isLockedByOther
                    ? 'border-slate-200 dark:border-slate-800 opacity-60 cursor-not-allowed pointer-events-none'
                    : isDragging
                    ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/30 cursor-pointer'
                    : 'border-slate-300 dark:border-slate-700 hover:border-indigo-500 cursor-pointer'
                }`}
                onClick={() => {
                  if (!isLockedByOther && selectedFiles.length === 0) fileInputRef.current?.click();
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
                        Any format, zero-RAM chunked disk slice {roomPassword ? '• AES-256-GCM E2EE Enabled' : ''}
                      </span>
                    </>
                  ) : selectedFiles.length === 1 ? (
                    <>
                      <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                        {selectedFiles[0].name}
                      </span>
                      <span className="text-xs text-slate-400">
                        {(selectedFiles[0].size / (1024 * 1024)).toFixed(2)} MB {roomPassword ? '• 🔒 Encrypted' : ''}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                        {selectedFiles.length} files selected
                      </span>
                      <span className="text-xs text-slate-400">
                        Total: {(selectedFiles.reduce((acc, f) => acc + f.size, 0) / (1024 * 1024)).toFixed(2)} MB {roomPassword ? '• 🔒 Encrypted' : ''}
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
              {isLockedByOther ? (
                <div className="w-full p-4 rounded-xl border border-amber-300 dark:border-amber-800/80 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 text-xs sm:text-sm font-semibold flex items-center justify-center gap-2.5 shadow-sm animate-pulse">
                  <span className="text-base sm:text-lg">🔒</span>
                  <span>
                    {transferLock?.senderName || 'Another peer'} is actively broadcasting. Transmission is locked for others until this transfer completes...
                  </span>
                </div>
              ) : (
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

                  {occupancy < 2 ? (
                    <button
                      type="button"
                      disabled
                      className="ml-auto px-6 py-2.5 rounded-xl text-xs sm:text-sm font-semibold bg-slate-200 dark:bg-slate-800 text-slate-400 cursor-not-allowed shadow-none"
                    >
                      Waiting for peers to join (At least 1 receiver required)
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleStartBroadcast}
                      disabled={selectedFiles.length === 0 || connectedPeers.length === 0 || isTransferring}
                      className={`ml-auto px-6 py-2.5 rounded-xl text-sm font-semibold shadow-md transition ${
                        selectedFiles.length === 0 || connectedPeers.length === 0 || isTransferring
                          ? 'bg-slate-200 dark:bg-slate-800 text-slate-400 cursor-not-allowed shadow-none'
                          : 'bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer'
                      }`}
                    >
                      {isTransferring
                        ? selectedFiles.length > 1
                          ? `Broadcasting (${currentBroadcastIndex + 1}/${selectedFiles.length})...`
                          : 'Broadcasting...'
                        : selectedFiles.length === 0
                        ? 'Select Files to Broadcast'
                        : connectedPeers.length === 0
                        ? 'Connecting Channels (0 Active Peers)...'
                        : selectedFiles.length > 1
                        ? `Broadcast ${selectedFiles.length} Files to ${connectedPeers.length} Peer(s)`
                        : `Broadcast to ${connectedPeers.length} Peer(s)`}
                    </button>
                  )}
                </div>
              )}
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
                          onClick={() => handleDownload(file)}
                          className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg shadow-sm transition cursor-pointer flex items-center gap-1"
                        >
                          <span>⬇</span> Download
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>

      {/* File Preview Modal */}
      <FilePreviewModal
        file={previewFile}
        isOpen={isPreviewOpen}
        onClose={() => setIsPreviewOpen(false)}
      />

      {/* QR Code Sharing Modal */}
      <QRCodeModal
        roomId={roomId}
        isOpen={isQRModalOpen}
        onClose={() => setIsQRModalOpen(false)}
      />

      {/* P2P Chat & Clipboard Sync Sidebar */}
      <ChatSidebar
        isOpen={isChatOpen}
        onClose={() => setIsChatOpen(false)}
        messages={chatMessages}
        onSendMessage={handleSendChatMessage}
        connectedPeersCount={connectedPeers.length}
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