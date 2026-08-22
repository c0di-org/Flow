import { Channel, convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { boardStore } from './store';
import { putWebAsset, webAssetKey, webAssetUrl } from './webAssets';
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
  return isTauri() ? convertFileSrc(path) : webAssetUrl(path);
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

// ---------------------------------------------------------------------------
// Browser fallback
//
// Outside Tauri there is no native dialog and no Rust importer, so the web
// build picks files with a plain file input, derives the same three variants
// the Rust importer produces, and stores them via `webAssets`.
// ---------------------------------------------------------------------------

const PREVIEW_EDGE = 1600;
const THUMB_EDGE = 420;
const MICRO_EDGE = 160;

export const IMAGE_PATTERN = /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i;

export function pickPhotoFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(input.files ? [...input.files] : []));
    // A cancelled picker fires no `change` in most browsers; `cancel` covers
    // the ones that support it so the caller is never left hanging.
    input.addEventListener('cancel', () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

async function encodeVariant(bitmap: ImageBitmap, edge: number): Promise<Blob> {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable');
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85));
  if (!blob) throw new Error('Could not encode image');
  return blob;
}

async function importOneFile(file: File): Promise<PhotoAsset> {
  const bitmap = await createImageBitmap(file);
  try {
    const id = crypto.randomUUID();
    const [preview, thumbnail, micro] = await Promise.all([
      encodeVariant(bitmap, PREVIEW_EDGE),
      encodeVariant(bitmap, THUMB_EDGE),
      encodeVariant(bitmap, MICRO_EDGE),
    ]);
    const previewKey = webAssetKey(id, 'preview');
    const thumbnailKey = webAssetKey(id, 'thumbnail');
    const microKey = webAssetKey(id, 'micro');
    await Promise.all([
      putWebAsset(previewKey, preview),
      putWebAsset(thumbnailKey, thumbnail),
      putWebAsset(microKey, micro),
    ]);
    return {
      id,
      name: file.name,
      // The browser cannot keep the untouched original without doubling
      // storage for no visible gain, so the preview stands in for it.
      originalPath: previewKey,
      previewPath: previewKey,
      thumbnailPath: thumbnailKey,
      microPath: microKey,
      pixelWidth: bitmap.width,
      pixelHeight: bitmap.height,
      bytes: file.size,
    };
  } finally {
    bitmap.close();
  }
}

export async function importPhotoFiles(
  files: File[],
  origin: Point,
  onProgress?: (progress: ImportProgress) => void,
  onFailure?: (path: string, message: string) => void,
) {
  const images = files.filter((file) => file.type.startsWith('image/') || IMAGE_PATTERN.test(file.name));
  if (!images.length) return;

  const total = images.length;
  let completed = 0;
  let failed = 0;
  const imported: PhotoAsset[] = [];
  onProgress?.({ total, completed, failed });

  // Sequential: decoding and re-encoding a full-size photo is memory hungry,
  // and a browser tab has far less headroom than the native importer.
  for (const file of images) {
    try {
      imported.push(await importOneFile(file));
    } catch (error) {
      failed++;
      onFailure?.(file.name, error instanceof Error ? error.message : String(error));
    }
    completed++;
    onProgress?.({ total, completed, failed });
  }

  if (imported.length) {
    boardStore.addPhotos(imported, origin);
    boardStore.flush();
  }
}
