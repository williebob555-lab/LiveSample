// Host bridge. Present under Electron, absent in a plain browser — every call
// site checks `hasNative` and falls back, so `npm run dev` in a browser stays
// usable for UI work without booting Electron.

export interface UpdateCheck {
  state: 'available' | 'none' | 'downloaded' | 'error' | 'unsupported';
  current: string;
  version?: string;
  notes?: string;
  date?: string;
  error?: string;
}

export interface SamplerNative {
  openAudio(): Promise<string[] | null>;
  openFolder(): Promise<string[] | null>;
  chooseDir(title?: string): Promise<string | null>;
  saveFile(name: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  read(path: string): Promise<ArrayBuffer>;
  write(path: string, data: Uint8Array): Promise<boolean>;
  mkdir(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  listAudio(dir: string): Promise<string[]>;
  join(...parts: string[]): Promise<string>;
  basename(path: string): Promise<string>;
  userData(): Promise<string>;
  documents(): Promise<string>;

  version(): Promise<string>;
  updatesCheck(): Promise<UpdateCheck>;
  updatesDownload(): Promise<{ ok: boolean; error?: string; version?: string }>;
  updatesInstall(): Promise<{ ok: boolean; error?: string }>;
  onUpdateProgress(fn: (p: { percent: number; transferred: number; total: number }) => void): () => void;

  /** Keep the main process informed so it can prompt before closing. */
  setDirty(dirty: boolean): void;
  /** Main asks the renderer to save (or not) before the window goes. */
  onCloseRequest(fn: (action: 'save' | 'discard') => void): () => void;
  /** Renderer is done; the window may now close. */
  closeReady(): void;
}

export const native: SamplerNative | undefined = (
  window as unknown as { samplerNative?: SamplerNative }
).samplerNative;

export const hasNative = !!native;

/** Basename without needing a round trip, for display and naming. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Browser fallback: pick files through a hidden input. */
export function pickFilesInBrowser(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener('change', () => resolve(input.files ? [...input.files] : []));
    input.click();
  });
}

/** Browser fallback: hand a file to the user as a download. */
export function downloadInBrowser(name: string, data: Uint8Array | string): void {
  const blob =
    typeof data === 'string'
      ? new Blob([data], { type: 'text/plain' })
      : new Blob([data as unknown as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
