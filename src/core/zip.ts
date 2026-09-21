import { downloadZip } from 'client-zip';

export interface ReceivedFileItem {
  name: string;
  path: string;
  url: string;
  blob?: Blob;
  checksum?: string;
}

export async function downloadAllAsZip(files: ReceivedFileItem[], zipName = 'droplink2-bundle.zip') {
  if (files.length === 0) return;

  const zipInputs = await Promise.all(
    files.map(async (item) => {
      const input = item.blob ? item.blob : await fetch(item.url);
      return {
        name: item.path || item.name,
        lastModified: new Date(),
        input,
      };
    })
  );

  const blob = await downloadZip(zipInputs).blob();

  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = zipName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}
