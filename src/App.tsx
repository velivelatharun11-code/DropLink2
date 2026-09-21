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
  Copy, Check, FolderUp, Files, Activity, Gauge, Database, Archive, Lock, Trash2, RefreshCw, XCircle, Folder 
} from 'lucide-react';

export default function App() {
  const [roomId, setRoomId] = useState('');
  const [password, setPassword] = useState('');
  const [joined, setJoined] = useState(false);
  const [qrSrc, setQrSrc] = useState('');
  const [status, setStatus] = useState('Idle');
  const [connectedPeer, setConnectedPeer] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<TransferMetrics | null>(null);
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
    const initialRoom = window.location.hash.replace('#', '') || Math.random().toString(36).substring(2, 8);
    setRoomId(initialRoom);
  }, []);

  const handleJoin = async () => {
    if (!roomId) return;
    window.location.hash = roomId;

    const currentUrl = `${window.location.origin}/#${roomId}`;
    const qr = await QRCode.toDataURL(currentUrl, { margin: 2, width: 200 });
    setQrSrc(qr);

    const signalingUrl = import.meta.env.VITE_SIGNALING_URL || (window.location.port === '5173' ? 'http://localhost:3001' : window.location.origin);

    engineRef.current = new DropLinkEngine(
      signalingUrl,
      {
        onPeerConnected: (id) => setConnectedPeer(id),
        onPeerDisconnected: () => {
          setConnectedPeer(null);
          setIsTransferring(false);
        },
        onTransferAborted: (reason) => {
          setIsTransferring(false);
          setMetrics(null);
          setStatus(reason || 'Transfer Aborted');
        },
        onMetrics: (m) => setMetrics(m),
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

  const handlePurgeAllOPFS = async () => {
    if (window.confirm('Are you sure you want to permanently delete all files in OPFS storage?')) {
      await purgeAllOPFS();
      setReceivedFiles([]);
      await refreshStorage();
    }
  };

  const handleCancelTransfer = () => {
    if (engineRef.current) {
      engineRef.current.cancelTransfer('Transfer aborted by user');
      setIsTransferring(false);
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
      engineRef.current.sendBatch(selectedItems).finally(() => setIsTransferring(false));
    }
  };

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

        {!joined ? (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-neutral-300 mb-1">Room Code</label>
              <input
                type="text"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-4 py-2 text-neutral-100 uppercase tracking-widest focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-neutral-300">
                  Optional Room Password (E2EE)
                </label>
                <span className="text-[11px] text-neutral-400">AES-GCM-256</span>
              </div>
              <div className="relative">
                <input
                  type="password"
                  placeholder="Leave empty for unencrypted transport"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg pl-9 pr-4 py-2 text-neutral-100 text-sm focus:outline-none focus:border-indigo-500"
                />
                <Lock className="w-4 h-4 text-neutral-400 absolute left-3 top-2.5" />
              </div>
            </div>

            <button
              onClick={handleJoin}
              className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 font-medium rounded-lg transition-colors cursor-pointer"
            >
              Join Room
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Status & Prominent Room Code */}
            <div className="flex flex-col sm:flex-row items-center justify-between p-4 bg-neutral-800/60 rounded-xl border border-neutral-800 gap-4">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Wifi className={`w-4 h-4 ${connectedPeer ? 'text-emerald-400' : 'text-amber-400 animate-pulse'}`} />
                  <span className="text-sm font-semibold">{connectedPeer ? 'Peer Connected' : 'Waiting for Peer'}</span>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-xs text-neutral-400 font-medium">Room:</span>
                  <span className="px-2.5 py-1 bg-neutral-900 border border-neutral-700 rounded-md font-mono text-sm font-bold tracking-widest text-indigo-400 uppercase">
                    {roomId}
                  </span>
                  <button
                    onClick={handleCopy}
                    className="flex items-center gap-1 text-xs bg-neutral-700 hover:bg-neutral-600 px-2.5 py-1 rounded text-neutral-200 transition-colors cursor-pointer"
                  >
                    {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-neutral-300" />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>

                {password && (
                  <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                    <Lock className="w-3.5 h-3.5" />
                    <span>Payload E2EE Enabled</span>
                  </div>
                )}

                <p className="text-xs text-neutral-400 max-w-xs">{status}</p>
              </div>

              {qrSrc && (
                <div className="bg-white p-1 rounded-lg shrink-0">
                  <img src={qrSrc} alt="Room QR" className="w-20 h-20" />
                </div>
              )}
            </div>

            {/* Selection Buttons: Files or Entire Folder */}
            <div className="space-y-3">
              <label className="block text-sm font-medium text-neutral-300">Choose Files or Entire Folder</label>
              
              <div className="grid grid-cols-2 gap-3">
                <label className="flex items-center justify-center gap-2 p-3 bg-neutral-800 hover:bg-neutral-700/80 border border-neutral-700 rounded-xl cursor-pointer text-xs font-medium transition-colors">
                  <Files className="w-4 h-4 text-indigo-400" />
                  <span>Select Files</span>
                  <input type="file" multiple onChange={handleFilesSelect} className="hidden" />
                </label>

                <label className="flex items-center justify-center gap-2 p-3 bg-neutral-800 hover:bg-neutral-700/80 border border-neutral-700 rounded-xl cursor-pointer text-xs font-medium transition-colors">
                  <FolderUp className="w-4 h-4 text-indigo-400" />
                  <span>Select Folder</span>
                  <input
                    type="file"
                    // @ts-expect-error webkitdirectory is standard for Chromium/WebKit
                    webkitdirectory=""
                    directory=""
                    onChange={handleFolderSelect}
                    className="hidden"
                  />
                </label>
              </div>

              {selectedItems.length > 0 && (
                <div className="text-xs text-neutral-400 px-1">
                  Staged: <span className="text-neutral-200 font-semibold">{selectedItems.length} items</span> ({
                    (selectedItems.reduce((acc, curr) => acc + curr.file.size, 0) / (1024 * 1024)).toFixed(2)
                  } MB total)
                </div>
              )}

              <button
                onClick={handleSend}
                disabled={selectedItems.length === 0 || !connectedPeer || isTransferring}
                className="w-full flex items-center justify-center gap-2 py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 font-medium rounded-lg transition-colors cursor-pointer"
              >
                <Send className="w-4 h-4" /> Stream Batch Directly to Disk
              </button>
            </div>

            {/* Live Throughput & Backpressure HUD */}
            {metrics && metrics.percent > 0 && (
              <div className="space-y-3 p-4 bg-neutral-950/60 rounded-xl border border-neutral-800">
                <div className="flex justify-between text-xs">
                  <span className="font-semibold text-neutral-300 truncate max-w-[200px]">
                    {metrics.currentFileName}
                  </span>
                  <span className="font-mono text-indigo-400">{metrics.percent.toFixed(1)}%</span>
                </div>

                <div className="w-full bg-neutral-800 rounded-full h-2 overflow-hidden">
                  <div 
                    className="bg-indigo-500 h-full transition-all duration-150" 
                    style={{ width: `${metrics.percent}%` }} 
                  />
                </div>

                {/* Telemetry Chips */}
                <div className="grid grid-cols-3 gap-2 pt-2 text-[11px] text-neutral-400 font-mono">
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
                  <div className="pt-2 flex items-center justify-end">
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
                  <div className="w-full bg-neutral-800 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-indigo-500 h-full transition-all"
                      style={{ width: `${Math.max(2, quotaInfo.percentUsed)}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Stored Files List */}
              <div className="flex-1 overflow-y-auto space-y-2 pr-1 min-h-[160px]">
                {opfsFiles.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-36 text-neutral-500 text-xs gap-2">
                    <Folder className="w-8 h-8 opacity-40" />
                    <span>No files currently saved in OPFS</span>
                  </div>
                ) : (
                  opfsFiles.map((file, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between p-2.5 bg-neutral-800/50 hover:bg-neutral-800/80 border border-neutral-800 rounded-lg text-xs"
                    >
                      <div className="truncate pr-2 max-w-[280px]">
                        <p className="text-neutral-200 font-medium truncate" title={file.path}>
                          {file.path}
                        </p>
                        <p className="text-[10px] text-neutral-400 font-mono">
                          {(file.size / (1024 * 1024)).toFixed(2)} MB
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          onClick={() => handleDownloadOPFSFile(file.path, file.name)}
                          className="p-1.5 bg-neutral-700/60 hover:bg-neutral-700 rounded text-indigo-400 hover:text-indigo-300 transition-colors cursor-pointer"
                          title="Download file"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDeleteOPFSFile(file.path)}
                          className="p-1.5 bg-rose-950/40 hover:bg-rose-900/60 rounded text-rose-400 transition-colors cursor-pointer"
                          title="Delete from OPFS"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Actions Footer */}
              <div className="flex items-center justify-between pt-3 border-t border-neutral-800">
                <button
                  onClick={refreshStorage}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs font-medium rounded-lg transition-colors cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Refresh</span>
                </button>
                {opfsFiles.length > 0 && (
                  <button
                    onClick={handlePurgeAllOPFS}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-950/80 hover:bg-rose-900 border border-rose-800/80 text-rose-300 text-xs font-medium rounded-lg transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Purge All Storage</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
