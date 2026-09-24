import React, { useEffect, useState } from 'react';

export interface PreviewableFile {
  name: string;
  size: number;
  type?: string;
  blob?: Blob;
  url?: string;
}

interface FilePreviewModalProps {
  file: PreviewableFile | null;
  isOpen: boolean;
  onClose: () => void;
}

export const FilePreviewModal: React.FC<FilePreviewModalProps> = ({ file, isOpen, onClose }) => {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loadingText, setLoadingText] = useState(false);

  useEffect(() => {
    if (!file || !isOpen) {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        setObjectUrl(null);
      }
      setTextContent(null);
      return;
    }

    if (file.url) {
      setObjectUrl(file.url);
    } else if (file.blob) {
      const url = URL.createObjectURL(file.blob);
      setObjectUrl(url);

      const isText =
        file.type?.startsWith('text/') ||
        /\.(txt|md|json|js|ts|tsx|jsx|html|css|py|csv|log)$/i.test(file.name);

      if (isText && file.size < 5 * 1024 * 1024) {
        setLoadingText(true);
        file.blob
          .text()
          .then((text) => setTextContent(text))
          .catch(() => setTextContent('Failed to read file contents as text.'))
          .finally(() => setLoadingText(false));
      }
    }

    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [file, isOpen]);

  if (!isOpen || !file) return null;

  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  const isImage = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'].includes(ext) || file.type?.startsWith('image/');
  const isVideo = ['mp4', 'webm', 'ogg'].includes(ext) || file.type?.startsWith('video/');
  const isAudio = ['mp3', 'wav', 'ogg', 'm4a', 'aac'].includes(ext) || file.type?.startsWith('audio/');
  const isPdf = ext === 'pdf' || file.type === 'application/pdf';
  const isText = Boolean(textContent !== null || loadingText);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 transition-all">
      <div className="relative flex flex-col w-full max-w-3xl max-h-[85vh] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
          <div className="flex flex-col truncate pr-4">
            <span className="font-semibold text-slate-800 dark:text-slate-100 truncate text-base">
              {file.name}
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {formatBytes(file.size)} • {file.type || ext.toUpperCase() || 'Binary'}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Content Viewer */}
        <div className="flex-1 overflow-auto p-6 flex items-center justify-center bg-slate-100/50 dark:bg-slate-900/50">
          {isImage && objectUrl && (
            <img
              src={objectUrl}
              alt={file.name}
              className="max-h-[60vh] max-w-full rounded-lg object-contain shadow-md"
            />
          )}

          {isVideo && objectUrl && (
            <video
              src={objectUrl}
              controls
              className="max-h-[60vh] w-full rounded-lg shadow-md bg-black"
            />
          )}

          {isAudio && objectUrl && (
            <div className="w-full max-w-md p-6 bg-white dark:bg-slate-800 rounded-2xl shadow-lg border border-slate-200 dark:border-slate-700 text-center">
              <audio src={objectUrl} controls className="w-full mt-2" />
            </div>
          )}

          {isPdf && objectUrl && (
            <iframe
              src={objectUrl}
              title={file.name}
              className="w-full h-[60vh] rounded-lg border border-slate-300 dark:border-slate-700"
            />
          )}

          {isText && (
            <div className="w-full h-[60vh] bg-slate-950 text-slate-100 font-mono text-xs p-4 rounded-xl overflow-auto border border-slate-800">
              {loadingText ? (
                <div className="flex items-center justify-center h-full text-slate-400">Loading contents...</div>
              ) : (
                <pre className="whitespace-pre-wrap">{textContent}</pre>
              )}
            </div>
          )}

          {!isImage && !isVideo && !isAudio && !isPdf && !isText && (
            <div className="flex flex-col items-center justify-center text-center p-8 space-y-3">
              <div className="w-16 h-16 rounded-2xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800/60 flex items-center justify-center text-2xl font-bold text-indigo-600 dark:text-indigo-400">
                {ext ? ext.toUpperCase().slice(0, 4) : 'FILE'}
              </div>
              <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Preview not supported for this file type
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xs">
                This file format must be saved directly to disk.
              </p>
              {objectUrl && (
                <a
                  href={objectUrl}
                  download={file.name}
                  className="mt-2 inline-flex items-center px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-xl shadow transition"
                >
                  Download File
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};