import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';

interface QRCodeModalProps {
  roomId: string;
  isOpen: boolean;
  onClose: () => void;
}

export const QRCodeModal: React.FC<QRCodeModalProps> = ({ roomId, isOpen, onClose }) => {
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);

  const roomUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/#${roomId}`
    : `/#${roomId}`;

  useEffect(() => {
    if (!isOpen || !roomId) return;

    QRCode.toDataURL(roomUrl, {
      width: 280,
      margin: 2,
      color: {
        dark: '#0f172a',
        light: '#ffffff'
      },
      errorCorrectionLevel: 'M'
    })
      .then((url: string) => setQrDataUrl(url))
      .catch((err: unknown) => console.error('Failed to generate QR code:', err));
  }, [isOpen, roomId, roomUrl]);

  if (!isOpen) return null;

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(roomUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy link:', err);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 transition-all"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="relative flex flex-col w-full max-w-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl shadow-2xl overflow-hidden p-6 text-center space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
          <div className="text-left">
            <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
              <span>📱</span> Room QR Code
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">Scan to connect mesh peer</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        {/* QR Code Canvas/Image */}
        <div className="flex items-center justify-center p-4 bg-white rounded-2xl border border-slate-200 dark:border-slate-700 shadow-inner mx-auto">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={`QR Code for room ${roomId}`}
              className="w-56 h-56 rounded-lg object-contain"
            />
          ) : (
            <div className="w-56 h-56 flex items-center justify-center text-xs text-slate-400">
              Generating QR Code...
            </div>
          )}
        </div>

        {/* Room Info & Instructions */}
        <div className="space-y-1">
          <div className="text-xs uppercase font-semibold text-slate-400">Room Hash</div>
          <div className="font-mono font-bold text-lg text-indigo-600 dark:text-indigo-400">
            #{roomId}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 pt-1">
            Point an iPhone or Android camera to instantly join this 5-peer mesh room.
          </p>
        </div>

        {/* Action Button */}
        <button
          type="button"
          onClick={handleCopyLink}
          className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-xl shadow-md transition cursor-pointer flex items-center justify-center gap-2"
        >
          {copied ? '✓ Link Copied to Clipboard!' : 'Copy Direct Room Link'}
        </button>
      </div>
    </div>
  );
};
