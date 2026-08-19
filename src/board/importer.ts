import { Channel, convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { boardStore } from './store';
import type { PhotoAsset, Point } from './types';

type NativeAsset = {
  id: string;
  name: string;
  original_path: string;
  preview_path: string;
  thumbnail_path: string;
  micro_path: string;
  pixel_width: number;
  pixel_height: number;
  bytes: number;
};

type ImportEvent =
  | { type: 'started'; total: number }
  | { type: 'imported'; asset: NativeAsset }
  | { type: 'failed'; path: string; message: string }
  | { type: 'finished'; imported: number; failed: number };

export type ImportProgress = { total: number; completed: number; failed: number };

function toAsset(asset: NativeAsset): PhotoAsset {
  return {
    id: asset.id,
    name: asset.name,
    originalPath: asset.original_path,
    previewPath: asset.preview_path,
    thumbnailPath: asset.thumbnail_path,
    microPath: asset.micro_path,
    pixelWidth: asset.pixel_width,
    pixelHeight: asset.pixel_height,
    bytes: asset.bytes,
  };
}

export function assetUrl(path: string) {
  return isTauri() ? convertFileSrc(path) : path;
}

export async function choosePhotos(): Promise<string[]> {
  if (!isTauri()) return [];
  const result = await open({
    multiple: true,
    directory: false,
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff'] },
    ],
  });
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

export async function importPhotoPaths(
  paths: string[],
  origin: Point,
  onProgress?: (progress: ImportProgress) => void,
  onFailure?: (path: string, message: string) => void,
) {
  if (!paths.length || !isTauri()) return;

  const imported: PhotoAsset[] = [];
  let total = paths.length;
  let completed = 0;
  let failed = 0;
  let flushed = false;
  const channel = new Channel<ImportEvent>();
  channel.onmessage = (event) => {
    if (event.type === 'started') total = event.total;
    if (event.type === 'imported') {
      imported.push(toAsset(event.asset));
      completed++;
    }
    if (event.type === 'failed') {
      failed++;
      completed++;
      onFailure?.(event.path, event.message);
    }
    if (event.type === 'finished' && !flushed) {
      flushed = true;
      if (imported.length) {
        boardStore.addPhotos(imported, origin);
        // Persist local recovery state immediately at the end of a large batch.
        // Native mirroring remains async, while startup reconciliation protects
        // local-newer boards before orphan cleanup runs.
        boardStore.flush();
      }
    }
    onProgress?.({ total, completed, failed });
  };

  await invoke('import_images', {
    boardId: boardStore.state.document.id,
    paths,
    onEvent: channel,
  });
}
