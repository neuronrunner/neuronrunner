export interface UploadEntry {
  file: File;
  relativePath: string;
}

export interface UploadSelection {
  files: UploadEntry[];
  directories: string[];
}

// Keep the chosen folder itself and all of its descendants inside the destination.
export function selectedUploadFiles(files: File[]): UploadSelection {
  return {
    files: files.map(file => ({ file, relativePath: file.webkitRelativePath || file.name })),
    directories: [],
  };
}

export function uploadDestination(folder: string, relativePath: string): string {
  const parts = relativePath.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[\\\x00-\x1f]/.test(part))) {
    throw new Error("Invalid upload path");
  }
  return `${folder.replace(/\/+$/, "")}/${parts.join("/")}`;
}

export async function droppedUploadFiles(transfer: DataTransfer): Promise<UploadSelection> {
  // Capture entries while the drop event still permits access to DataTransfer.
  const entries = Array.from(transfer.items)
    .filter(item => item.kind === "file")
    .map(item => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile() }));
  const fallback = Array.from(transfer.files);
  const result: UploadSelection = { files: [], directories: [] };
  const visit = async (entry: FileSystemEntry, prefix = "") => {
    const relativePath = prefix + entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      result.files.push({ file, relativePath });
    } else if (entry.isDirectory) {
      result.directories.push(relativePath);
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // Chromium returns directories in batches. Read until the final empty batch.
      while (true) {
        const children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!children.length) break;
        for (const child of children) await visit(child, `${relativePath}/`);
      }
    }
  };
  if (!entries.length) return selectedUploadFiles(fallback);
  for (const { entry, file } of entries) {
    if (entry) await visit(entry);
    else if (file) result.files.push({ file, relativePath: file.webkitRelativePath || file.name });
  }
  return result;
}
