import { buildPrompt, screenshotFilename, type Note } from './core';

// Store-only ZIP: PNG is already compressed. Keeps the export entirely local
// and interoperable without a runtime dependency or a background upload.
export function feedbackArchive(notes: Note[], preamble: string): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const files = [{ name: 'comments.md', data: encoder.encode(buildPrompt(notes, preamble)) },
    ...notes.filter(note => note.screenshot).map(note => ({
      name: screenshotFilename(note),
      data: Uint8Array.from(atob(note.screenshot!.dataUrl.split(',')[1]), char => char.charCodeAt(0)),
    }))];
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true);
    view.setUint16(6, 0x800, true); view.setUint16(12, 33, true);
    view.setUint32(14, crc, true); view.setUint32(18, file.data.length, true); view.setUint32(22, file.data.length, true);
    view.setUint16(26, name.length, true); header.set(name, 30);
    const entry = new Uint8Array(46 + name.length);
    const central = new DataView(entry.buffer);
    central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true);
    central.setUint16(8, 0x800, true); central.setUint16(14, 33, true);
    central.setUint32(16, crc, true); central.setUint32(20, file.data.length, true); central.setUint32(24, file.data.length, true);
    central.setUint16(28, name.length, true); central.setUint32(42, offset, true); entry.set(name, 46);
    parts.push(header, file.data); directory.push(entry); offset += header.length + file.data.length;
  }
  const size = directory.reduce((sum, entry) => sum + entry.length, 0);
  const end = new Uint8Array(22); const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, files.length, true); view.setUint16(10, files.length, true);
  view.setUint32(12, size, true); view.setUint32(16, offset, true);
  const archive = new Uint8Array(offset + size + end.length);
  let position = 0;
  for (const part of [...parts, ...directory, end]) { archive.set(part, position); position += part.length; }
  return archive;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function downloadFile(data: Blob, name: string) {
  const url = URL.createObjectURL(data);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
