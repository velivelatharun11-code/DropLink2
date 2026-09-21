export interface StoredOPFSFile {
  name: string;
  path: string;
  size: number;
  lastModified: number;
}

export interface StorageQuotaInfo {
  usageBytes: number;
  quotaBytes: number;
  percentUsed: number;
}

/**
 * Recursively scans the Origin Private File System (OPFS) and lists all stored files with relative paths.
 */
export async function listOPFSFiles(
  directoryHandle?: FileSystemDirectoryHandle,
  currentPath = ''
): Promise<StoredOPFSFile[]> {
  const files: StoredOPFSFile[] = [];
  try {
    const root = directoryHandle || (await navigator.storage.getDirectory());
    // @ts-ignore - async iterator for FileSystemDirectoryHandle
    for await (const [name, handle] of root.entries()) {
      const entryPath = currentPath ? `${currentPath}/${name}` : name;
      if (handle.kind === 'file') {
        const file = await (handle as FileSystemFileHandle).getFile();
        files.push({
          name,
          path: entryPath,
          size: file.size,
          lastModified: file.lastModified,
        });
      } else if (handle.kind === 'directory') {
        const subFiles = await listOPFSFiles(handle as FileSystemDirectoryHandle, entryPath);
        files.push(...subFiles);
      }
    }
  } catch (err) {
    console.warn('Failed to query OPFS directory:', err);
  }
  return files;
}

/**
 * Retrieves the current browser storage quota and used bytes for this origin.
 */
export async function getStorageQuota(): Promise<StorageQuotaInfo> {
  if (navigator.storage && navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate();
    const usage = estimate.usage || 0;
    const quota = estimate.quota || 1;
    return {
      usageBytes: usage,
      quotaBytes: quota,
      percentUsed: Math.min(100, Math.round((usage / quota) * 100)),
    };
  }
  return { usageBytes: 0, quotaBytes: 0, percentUsed: 0 };
}

/**
 * Retrieves a specific file from OPFS as a Blob given its relative path.
 */
export async function getOPFSFileBlob(filePath: string): Promise<Blob | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const parts = filePath.split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) return null;

    let currentDir = root;
    for (const part of parts) {
      currentDir = await currentDir.getDirectoryHandle(part, { create: false });
    }

    const fileHandle = await currentDir.getFileHandle(fileName, { create: false });
    return await fileHandle.getFile();
  } catch (err) {
    console.warn(`Failed to read OPFS file ${filePath}:`, err);
    return null;
  }
}

/**
 * Deletes an individual file or directory from OPFS by relative path.
 */
export async function purgeOPFSEntry(filePath: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const parts = filePath.split('/').filter(Boolean);
  const targetName = parts.pop();
  if (!targetName) return;

  let currentDir = root;
  for (const part of parts) {
    currentDir = await currentDir.getDirectoryHandle(part, { create: false });
  }

  await currentDir.removeEntry(targetName, { recursive: true });
}

/**
 * Completely purges all stored files and subdirectories from the root of OPFS.
 */
export async function purgeAllOPFS(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  // @ts-ignore
  for await (const [name] of root.entries()) {
    await root.removeEntry(name, { recursive: true }).catch((err) => {
      console.warn(`Failed to remove entry ${name}:`, err);
    });
  }
}
