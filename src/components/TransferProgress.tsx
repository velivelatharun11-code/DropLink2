import React from 'react';
import type { TransferProgress as ProgressData } from '../core/webrtc';

export interface TransferProgressProps {
  progress: ProgressData | null;
  direction: 'upload' | 'download';
}

export const TransferProgress: React.FC<TransferProgressProps> = ({ progress, direction }) => {
  if (!progress) return null;

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  };

  const formatSpeed = (bytesPerSec: number): string => {
    if (bytesPerSec > 1024 * 1024) {
      return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
    }
    return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  };

  const remainingBytes = Math.max(0, progress.totalBytes - progress.transferredBytes);
  const etaSec = progress.speedBps > 0 ? Math.ceil(remainingBytes / progress.speedBps) : 0;

  const formatEta = (sec: number): string => {
    if (sec <= 0 || !isFinite(sec)) return '--';
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s}s`;
  };

  return (
    <div className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-lg space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex flex-col truncate pr-3">
          <div className="flex items-center gap-2">
            <span
              className={`px-2 py-0.5 text-[10px] font-bold rounded-md uppercase tracking-wider ${
                direction === 'upload'
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                  : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
              }`}
            >
              {direction}
            </span>
            <span className="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate">
              {progress.fileName}
            </span>
          </div>
          <span className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {formatBytes(progress.transferredBytes)} of {formatBytes(progress.totalBytes)} (
            {progress.percentage}%)
          </span>
        </div>

        <div className="text-right shrink-0">
          <div className="text-sm font-bold font-mono text-indigo-600 dark:text-indigo-400">
            {formatSpeed(progress.speedBps)}
          </div>
          <div className="text-[11px] text-slate-400">ETA: {formatEta(etaSec)}</div>
        </div>
      </div>

      <div className="relative w-full h-3 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 rounded-full transition-all duration-150 ease-out"
          style={{ width: `${Math.min(100, progress.percentage)}%` }}
        />
      </div>

      <div className="pt-1 border-t border-slate-100 dark:border-slate-800/80">
        <div className="flex items-center justify-between text-[11px] text-slate-400 mb-2">
          <span>Active DataChannel Stripes (Multiplexed UDP)</span>
          <span>{progress.connectedPeersCount} Peer(s) Synced</span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {[0, 1, 2, 3].map((stripeIdx) => {
            const isActive = progress.activeStripes.includes(stripeIdx);
            return (
              <div
                key={stripeIdx}
                className={`py-1.5 px-2 rounded-lg border text-center transition-all duration-150 ${
                  isActive
                    ? 'border-indigo-500/80 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-300 font-bold shadow-sm'
                    : 'border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-slate-900/40 text-slate-400'
                }`}
              >
                <div className="flex items-center justify-center gap-1.5 text-[10px]">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      isActive ? 'bg-indigo-500 animate-pulse' : 'bg-slate-300 dark:bg-slate-700'
                    }`}
                  />
                  Lane {stripeIdx + 1}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default TransferProgress;