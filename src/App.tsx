import { useState, useEffect, useRef, type ChangeEvent } from 'react';
import QRCode from 'qrcode';
import { DropLinkEngine, type ExtendedFile, type TransferMetrics } from './core/webrtc';
import { downloadAllAsZip } from './core/zip';
import {
  listOPFSFiles,
  getStorageQuota,
  getOPFSFileBlob,
  purgeOPFSEntry,
  purgeAllOPFS,
  type StoredOPFSFile,
  type StorageQuotaInfo
} from './storage/cleaner';
import { 
  HardDrive, Send, Download, Wifi, CheckCircle2, ShieldCheck, 
  Copy, Check, FolderUp, Files, Activity, Gauge, Database, Archive, Lock, Trash2, RefreshCw, XCircle, Folder,
  Pause, Play, QrCode
} from 'lucide-react';

export default function App() {
  const [roomId, setRoomId] = useState('');
  const [password, setPassword] = useState('');
  const [joined, setJoined] = useState(false);
  const [qrSrc, setQrSrc] = useState('');
  const [showQrModal, setShowQrModal] = useState(false);
  const [status, setStatus] = useState('Idle');
  const [connectedPeer, setConnectedPeer] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<TransferMetrics | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [receivedFiles, setReceivedFiles] = useState<{ 
    name: string; 
    path: string; 
    url: string; 
    blob: Blob;
    checksum?: string;
  }[]>([]);
  const [selectedItems, setSelectedItems] = useState<ExtendedFile[]>([]);
  const [copied, setCopied] = useState(false);
  const [showStorageModal, setShowStorageModal] = useState(false);
  const [opfsFiles, setOpfsFiles] = useState<StoredOPFSFile[]>([]);
  const [quotaInfo, setQuotaInfo] = useState<StorageQuotaInfo | null>(null);
  const [isTransferring, setIsTransferring] = useState(false);

  const engineRef = useRef<DropLinkEngine | null>(null);

  useEffect(() => {
    const initialRoom = window.location.hash.replace('#', '') || Math.random().toString(36).substring(2,8);
    setRoomId(initialRoom);
  }, []);

  const handleJoin = async () => {
    if (!roomId) return;
    window.location.hash = roomId;

    const currentUrl = `${window.location.origin}/#${roomId}`;
    try {
      const qr = await QRCode.toDataURL(currentUrl, { margin: 2, width: 220 });
      setQrSrc(qr);
    } catch (err) {
      console.warn('QR code generation failed:', err);
    }

    const signalingUrl = import.meta.env.VITE_SIGNALING_URL || (window.location.origin);

    engineRef.current = new DropLinkEngine(
      signalingUrl,
      {
        onPeerConnected: (id) => setConnectedPeer(id),
        onPeerDisconnected: () => {
          setConnectedPeer(null);
          setIsTransferring(false);
          setIsPaused(false);
        },
        onTransferAborted: (reason) => {
          setIsTransferring(false);
          setIsPaused(false);
          setMetrics(null);
          setStatus(reason || 'Transfer Aborted');
        },
        onTransferPaused: () => {
          setIsPaused(true);
        },
        onTransferResumed: () => {
          setIsPaused(false);
        },
        onMetrics: (m) => {
          setMetrics(m);
          if (typeof m.isPaused === 'boolean') {
            setIsPaused(m.isPaused);
          }
        },
        onFileReceived: (name, path, file, checksum) => {
          const url = URL.createObjectURL(file);
          setReceivedFiles((prev) => [{ name, path, url, blob: file, checksum }, ...prev]);
        },
        onStatusChange: (msg) => setStatus(msg),
      },
      password
    );

    engineRef.current.joinRoom(roomId);
    setJoined(true);
  };

  const refreshStorage = async () => {
    try {
      const [files, quota] = await Promise.all([listOPFSFiles(), getStorageQuota()]);
      setOpfsFiles(files);
      setQuotaInfo(quota);
    } catch (err) {
      console.warn('Storage refresh error:', err);
    }
  };

  useEffect(() => {
    refreshStorage();
  }, [receivedFiles]);

  const handleDownloadOPFSFile = async (filePath: string, fileName: string) => {
    const blob = await getOPFSFileBlob(filePath);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDeleteOPFSFile = async (filePath: string) => {
    await purgeOPFSEntry(filePath);
    await refreshStorage();
  };

  const handlePurgeAll = async () => {
    if (confirm('Delete all files currently in OPFS storage?')) {
      await purgeAllOPFS();
      await refreshStorage();
      setReceivedFiles([]);
    }
  };

  const handleTogglePause = () => {
    if (!engineRef.current) return;
    if (isPaused) {
      engineRef.current.resumeTransfer();
      setIsPaused(false);
    } else {
      engineRef.current.pauseTransfer();
      setIsPaused(true);
    }
  };

  const handleCancelTransfer = () => {
    if (engineRef.current) {
      engineRef.current.cancelTransfer('Transfer aborted by user');
      setIsTransferring(false);
      setIsPaused(false);
      setMetrics(null);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(roomId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleFilesSelect = (e: ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const items: ExtendedFile[] = Array.from(e.target.files).map((file) => ({
      file,
      relativePath: file.name,
    }));
    setSelectedItems(items);
  };

  const handleFolderSelect = (e: ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const items: ExtendedFile[] = Array.from(e.target.files).map((file) => ({
      file,
      relativePath: file.webkitRelativePath || file.name,
    }));
    setSelectedItems(items);
  };

  const handleSend = () => {
    if (selectedItems.length > 0 && engineRef.current) {
      setIsTransferring(true);
      setIsPaused(false);
      engineRef.current.sendBatch(selectedItems).finally(() => {
        setIsTransferring(false);
        setIsPaused(false);
      });
    }
  };

  // Transfer is in-flight if transferring flag is on OR metrics indicate active incomplete work
  const isInFlight = (isTransferring || (metrics && metrics.percent < 100 && metrics.percent > 0));

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col items-center justify-center p-6 font-sans">
      <div className="max-w-xl w-full bg-neutral-900 border border-neutral-800 rounded-2xl p-6 shadow-2xl space-y-6">
        
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-600/20 text-indigo-400 rounded-lg">
              <HardDrive className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">DropLink2</h1>
              <p className="text-xs text-neutral-400">Zero-RAM OPFS P2P Streamer</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs px-3 py-1 bg-neutral-800 rounded-full border border-neutral-700">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span className="text-neutral-300">
              {password ? 'E2EE AES-GCM' : 'SyncAccessHandle'}
            </span>
          </div>
        </div>

        {/* Room / Controls Section */}
        {!joined ? (
          <div className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-neutral-400 uppercase tracking-wider block mb-1">
                Room ID
              </label>
              <input
                type="text"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                placeholder="Enter or create room code"
                className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-3 text-sm focus:outline-hidden focus:border-indigo-500 font-mono"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-neutral-400 uppercase tracking-wider block mb-1">
                Password (Optional End-to-End Encryption)
              </label>
              <div className="relative">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Leave empty for unencrypted fast stream"
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-3 text-sm focus:outline-hidden focus:border-indigo-500 pl-10"
                />
                <Lock className="w-4 h-4 text-neutral-500 absolute left-3.5 top-3.5" />
              </div>
            </div>

            <button
              onClick={handleJoin}
              className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-3 rounded-xl transition-colors shadow-lg shadow-indigo-600/20 cursor-pointer"
            >
              Join Room
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Connection Status Bar */}
            <div className="flex items-center justify-between p-3 bg-neutral-950/60 rounded-xl border border-neutral-800/80">
              <div className="flex items-center gap-2.5">
                <div className="relative flex items-center justify-center">
                  <Wifi className={`w-4 h-4 ${connectedPeer ? 'text-emerald-400' : 'text-amber-400 animate-pulse'}`} />
                </div>
                <div className="flex flex-col">
                  <span className="text-xs font-medium text-neutral-200">
                    {connectedPeer ? 'Peer Connected' : 'Waiting for Peer'}
                  </span>
                  <span className="text-[10px] text-neutral-400">
                    Room: <span className="font-mono text-neutral-200">{roomId}</span>
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                {qrSrc && (
                  <button
                    onClick={() => setShowQrModal(true)}
                    className="p-1.5 hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 rounded-lg transition-colors cursor-pointer"
                    title="View QR Code"
                  >
                    <QrCode className="w-4 h-4" />
                  </button>
                )}
                <button
                  onClick={handleCopy}
                  className="p-1.5 hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 rounded-lg transition-colors cursor-pointer"
                  title="Copy Room ID"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => { refreshStorage(); setShowStorageModal(true); }}
                  className="p-1.5 hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 rounded-lg transition-colors cursor-pointer"
                  title="OPFS Storage Manager"
                >
                  <Database className="w-4 h-4 text-indigo-400" />
                </button>
              </div>
            </div>

            {/* Status Feedback */}
            <div className="flex items-center justify-between text-xs px-1 text-neutral-400">
              <div className="truncate max-w-[280px]">
                <span className="text-neutral-500">Status: </span>
                <span className="text-neutral-300 font-mono">{status}</span>
              </div>
              {password && (
                <span className="text-[10px] text-emerald-400/80 flex items-center gap-1 bg-emerald-950/30 px-2 py-0.5 rounded border border-emerald-800/40">
                  <Lock className="w-3 h-3" /> E2EE Enabled
                </span>
              )}
            </div>

            {/* File Pickers */}
            <div className="space-y-3">
              <label className="text-xs font-semibold text-neutral-400 uppercase tracking-wider block">
                Choose Files or Entire Folder
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col items-center justify-center p-4 border border-dashed border-neutral-700 hover:border-indigo-500/50 hover:bg-indigo-500/5 rounded-xl cursor-pointer transition-all">
                  <Files className="w-6 h-6 text-indigo-400 mb-2" />
                  <span className="text-xs font-medium text-neutral-200">Select Files</span>
                  <input
                    type="file"
                    multiple
                    onChange={handleFilesSelect}
                    className="hidden"
                  />
                </label>

                <label className="flex flex-col items-center justify-center p-4 border border-dashed border-neutral-700 hover:border-indigo-500/50 hover:bg-indigo-500/5 rounded-xl cursor-pointer transition-all">
                  <FolderUp className="w-6 h-6 text-indigo-400 mb-2" />
                  <span className="text-xs font-medium text-neutral-200">Select Folder</span>
                  <input
                    type="file"
                    // @ts-expect-error webkitdirectory is non-standard
                    webkitdirectory=""
                    directory=""
                    multiple
                    onChange={handleFolderSelect}
                    className="hidden"
                  />
                </label>
              </div>

              {selectedItems.length > 0 && (
                <div className="p-3 bg-neutral-950/50 rounded-xl border border-neutral-800/80 flex items-center justify-between text-xs">
                  <span className="text-neutral-300">
                    Staged: <strong className="text-white">{selectedItems.length}</strong> items (
                    {(selectedItems.reduce((acc, curr) => acc + curr.file.size, 0) / (1024 * 1024)).toFixed(2)} MB total)
                  </span>
                </div>
              )}

              <button
                disabled={selectedItems.length === 0 || !connectedPeer || isTransferring}
                onClick={handleSend}
                className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl transition-colors shadow-lg shadow-indigo-600/20 flex items-center justify-center gap-2 cursor-pointer text-sm"
              >
                <Send className="w-4 h-4" />
                <span>Stream Batch Directly to Disk</span>
              </button>
            </div>

            {/* Metrics HUD */}
            {metrics && (
              <div className="p-4 bg-neutral-950 rounded-xl border border-neutral-800 space-y-3 font-mono text-xs">
                <div className="flex justify-between items-center text-neutral-300">
                  <span className="truncate max-w-[200px] font-sans font-medium text-sm text-neutral-100 flex items-center gap-1.5">
                    {metrics.currentFileName}
                    {isPaused && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-950 border border-amber-800 text-amber-300 font-bold">
                        PAUSED
                      </span>
                    )}
                  </span>
                  <span className="text-indigo-400 font-bold text-sm">
                    {metrics.percent.toFixed(1)}%
                  </span>
                </div>

                <div className="w-full bg-neutral-800 h-2 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-150 ${isPaused ? 'bg-amber-500' : 'bg-indigo-500'}`}
                    style={{ width: `${metrics.percent}%` }}
                  />
                </div>

                <div className="grid grid-cols-3 gap-2 text-[11px] text-neutral-400">
                  <div className="flex items-center gap-1.5 p-2 bg-neutral-900 rounded border border-neutral-800">
                    <Gauge className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                    <span>{metrics.speedMBps.toFixed(1)} MB/s</span>
                  </div>
                  <div className="flex items-center gap-1.5 p-2 bg-neutral-900 rounded border border-neutral-800">
                    <Activity className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span>{metrics.bufferedAmountMB.toFixed(1)} MB buf</span>
                  </div>
                  <div className="flex items-center gap-1.5 p-2 bg-neutral-900 rounded border border-neutral-800">
                    <Database className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span>{(metrics.bytesTransferred / (1024 * 1024)).toFixed(0)} MB done</span>
                  </div>
                </div>

                <div className="pt-2 flex items-center justify-end gap-2">
                  {/* Both Sender and Receiver can pause/resume if transfer is active or paused */}
                  {(isInFlight || isPaused) && (
                    <button
                      onClick={handleTogglePause}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors cursor-pointer ${
                        isPaused
                          ? 'bg-emerald-950/80 hover:bg-emerald-900 border-emerald-700 text-emerald-300'
                          : 'bg-amber-950/80 hover:bg-amber-900 border-amber-700 text-amber-300'
                      }`}
                    >
                      {isPaused ? <Play className="w-4 h-4 text-emerald-400" /> : <Pause className="w-4 h-4 text-amber-400" />}
                      <span>{isPaused ? 'Resume' : 'Pause'}</span>
                    </button>
                  )}
                  <button
                    onClick={handleCancelTransfer}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-950/70 hover:bg-rose-900 border border-rose-800/80 text-rose-300 text-xs font-semibold rounded-lg transition-colors cursor-pointer"
                  >
                    <XCircle className="w-4 h-4 text-rose-400" />
                    <span>Cancel Transfer</span>
                  </button>
                </div>
              </div>
            )}

            {/* Received Files List */}
            {receivedFiles.length > 0 && (
              <div className="space-y-3 border-t border-neutral-800 pt-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">
                    Completed Transfers ({receivedFiles.length})
                  </h3>
                  {receivedFiles.length > 1 && (
                    <button
                      onClick={() => downloadAllAsZip(receivedFiles, `droplink2-${roomId}.zip`)}
                      className="flex items-center gap-1.5 px-3 py-1 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-400 text-xs font-medium rounded-lg border border-indigo-500/30 transition-colors cursor-pointer"
                    >
                      <Archive className="w-3.5 h-3.5" />
                      <span>Download All as ZIP</span>
                    </button>
                  )}
                </div>

                <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                  {receivedFiles.map((f, i) => (
                    <div key={i} className="flex flex-col p-3 bg-neutral-800/40 rounded-lg border border-neutral-800 gap-1.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 truncate pr-2">
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                          <span className="text-sm truncate font-medium" title={f.path}>{f.path}</span>
                        </div>
                        <a
                          href={f.url}
                          download={f.name}
                          className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 font-medium shrink-0"
                        >
                          <Download className="w-4 h-4" /> Download
                        </a>
                      </div>
                      {f.checksum && (
                        <div className="text-[10px] font-mono text-neutral-400 truncate flex items-center gap-1 bg-neutral-900/60 px-2 py-1 rounded border border-neutral-800/80">
                          <span className="text-emerald-400 font-semibold">SHA-256:</span>
                          <span className="truncate text-neutral-300">{f.checksum}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* QR Code Modal */}
        {showQrModal && qrSrc && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-neutral-900 border border-neutral-800 rounded-2xl max-w-xs w-full p-6 shadow-2xl space-y-4 flex flex-col items-center">
              <div className="w-full flex items-center justify-between border-b border-neutral-800 pb-2">
                <span className="text-xs font-semibold text-neutral-300 uppercase tracking-wider">Scan to Join</span>
                <button
                  onClick={() => setShowQrModal(false)}
                  className="p-1 hover:bg-neutral-800 rounded-lg text-neutral-400 hover:text-neutral-200 transition-colors cursor-pointer"
                >
                  <XCircle className="w-4 h-4" />
                </button>
              </div>
              <div className="p-3 bg-white rounded-xl shadow-inner">
                <img src={qrSrc} alt="Room QR Code" className="w-44 h-44" />
              </div>
              <p className="text-[11px] font-mono text-neutral-400 text-center break-all">
                Room: {roomId}
              </p>
            </div>
          </div>
        )}

        {/* OPFS Storage Modal */}
        {showStorageModal && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-neutral-900 border border-neutral-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4 max-h-[85vh] flex flex-col">
              <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
                <div className="flex items-center gap-2">
                  <Database className="w-5 h-5 text-indigo-400" />
                  <h2 className="text-base font-bold text-neutral-100">OPFS Storage Manager</h2>
                </div>
                <button
                  onClick={() => setShowStorageModal(false)}
                  className="p-1 hover:bg-neutral-800 rounded-lg text-neutral-400 hover:text-neutral-200 transition-colors cursor-pointer"
                >
                  <XCircle className="w-5 h-5" />
                </button>
              </div>

              {/* Quota Bar */}
              {quotaInfo && (
                <div className="p-3 bg-neutral-950/70 border border-neutral-800 rounded-xl space-y-2 text-xs font-mono">
                  <div className="flex justify-between text-neutral-300">
                    <span>Used: {(quotaInfo.usageBytes / (1024 * 1024)).toFixed(1)} MB</span>
                    <span>Quota: {(quotaInfo.quotaBytes / (1024 * 1024 * 1024)).toFixed(1)} GB</span>
                  </div>
                  <div className="w-full bg-neutral-800 h-1.5 rounded-full overflow-hidden">
                    <div
                      className="bg-indigo-500 h-full transition-all"
                      style={{ width: `${Math.min(100, quotaInfo.percentUsed)}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Files Table */}
              <div className="flex-1 overflow-y-auto space-y-2 pr-1 min-h-[150px]">
                {opfsFiles.length === 0 ? (
                  <div className="text-center py-8 text-neutral-500 text-xs">
                    No files currently saved in browser OPFS storage.
                  </div>
                ) : (
                  opfsFiles.map((item, idx) => (
                    <div
                      key={idx}
                      className="p-2.5 bg-neutral-950/50 border border-neutral-800/80 rounded-lg flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center gap-2 truncate pr-2">
                        {item.path.includes('/') ? (
                          <Folder className="w-4 h-4 text-indigo-400 shrink-0" />
                        ) : (
                          <Files className="w-4 h-4 text-neutral-400 shrink-0" />
                        )}
                        <div className="flex flex-col truncate">
                          <span className="font-medium text-neutral-200 truncate">{item.name}</span>
                          <span className="text-[10px] text-neutral-500 truncate">{item.path}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] font-mono text-neutral-400">
                          {(item.size / (1024 * 1024)).toFixed(2)} MB
                        </span>
                        <button
                          onClick={() => handleDownloadOPFSFile(item.path, item.name)}
                          className="p-1 hover:bg-neutral-800 rounded text-neutral-400 hover:text-indigo-400 transition-colors cursor-pointer"
                          title="Download"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDeleteOPFSFile(item.path)}
                          className="p-1 hover:bg-neutral-800 rounded text-neutral-400 hover:text-rose-400 transition-colors cursor-pointer"
                          title="Delete from OPFS"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Modal Footer Actions */}
              <div className="flex items-center justify-between pt-3 border-t border-neutral-800">
                <button
                  onClick={refreshStorage}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg transition-colors cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Refresh
                </button>
                <button
                  onClick={handlePurgeAll}
                  disabled={opfsFiles.length === 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-950/50 border border-rose-900/50 rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Purge All Storage
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
