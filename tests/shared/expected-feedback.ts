import assert from 'node:assert/strict';
import { crc32, inflateRawSync } from 'node:zlib';

export function assertElementFeedback(prompt: string, selector: string) {
  assert.ok(prompt.includes(`- **Selector:** \`${selector}\``));
  assert.match(prompt, /## Page 1\n/);
  assert.match(prompt, /### Comment 1\n\n> /);
  assert.doesNotMatch(prompt, /```json|"selectorPath"|do-not-export-password|do-not-export-form-draft/);
}

// Read the ZIP central directory independently of the extension's archive writer.
// No system unzip dependency: this oracle also runs on Windows.
export function assertFeedbackArchive(zip: Buffer, prompt: string, png: Buffer) {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), 2);
  let offset = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < 2; i++) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50);
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    const local = zip.readUInt32LE(offset + 42);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    assert.ok(method === 0 || method === 8);
    const compressed = zip.subarray(start, start + size);
    const bytes = method === 8 ? inflateRawSync(compressed) : compressed;
    assert.equal(bytes.length, zip.readUInt32LE(offset + 24));
    assert.equal(crc32(bytes), zip.readUInt32LE(offset + 16));
    assert.ok(!files.has(name));
    files.set(name, bytes);
    offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  assert.equal(offset, end);
  assert.equal(files.get('comments.md')?.toString('utf8'), prompt);
  const imageName = prompt.match(/Screenshot file:\*\* `([^`]+)`/)?.[1];
  assert.ok(imageName);
  assert.deepEqual(files.get(imageName), png);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
}

// Read every ZIP entry independently of the extension's archive writer,
// checking sizes, checksums and safe, unique entry names.
export function archiveEntries(zip: Buffer): Map<string, Buffer> {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50);
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    const local = zip.readUInt32LE(offset + 42);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    assert.ok(method === 0 || method === 8);
    const compressed = zip.subarray(start, start + size);
    const bytes = method === 8 ? inflateRawSync(compressed) : compressed;
    assert.equal(bytes.length, zip.readUInt32LE(offset + 24));
    assert.equal(crc32(bytes), zip.readUInt32LE(offset + 16));
    assert.ok(!files.has(name), `duplicate entry ${name}`);
    assert.ok(!name.includes('/') && !name.includes('\\') && !name.startsWith('.'), `unsafe entry ${name}`);
    assert.ok(name.length <= 255, `entry too long ${name}`);
    files.set(name, bytes);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(offset, end);
  return files;
}

// Parse a journey archive independently of the extension's archive writer.
// Verifies the prompt section, the journeys document, every PNG payload, and
// deterministic unique filenames without depending on entry order.
export function assertJourneyArchive(
  zip: Buffer,
  expected: { commentsMd: string; journeysMd: string; pngs: Map<string, Buffer> },
) {
  const { commentsMd, journeysMd, pngs } = expected;
  const files = archiveEntries(zip);
  assert.equal(files.get('comments.md')?.toString('utf8'), commentsMd);
  assert.equal(files.get('journeys.md')?.toString('utf8'), journeysMd);
  assert.equal(files.size, 2 + pngs.size);
  for (const [name, png] of pngs) {
    assert.deepEqual(files.get(name), png);
    assert.equal(png.subarray(0, 8).toString('binary'), '\x89PNG\r\n\x1a\n');
  }
  const lowered = [...files.keys()].map(name => name.toLowerCase());
  assert.equal(new Set(lowered).size, lowered.length);
}
