/**
 * Secure file storage for photos, drawings and CAD files.
 * - files live outside the web root, in .data/uploads/<owner-type>/<id>/<uuid>.<ext>
 * - only whitelisted extensions/mime types are accepted
 * - the real mime type is sniffed from the magic bytes and stored in the DB
 * - downloads are authorisation-checked by the caller, never by URL obscurity
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.js';
import { badRequest, notFound, tooLarge } from './errors.js';

const SIGNATURES = [
  { mime: 'image/jpeg', ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: '.png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/gif', ext: '.gif', test: (b) => b.slice(0, 6).toString('latin1').startsWith('GIF8') },
  {
    mime: 'image/webp',
    ext: '.webp',
    test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP',
  },
  { mime: 'application/pdf', ext: '.pdf', test: (b) => b.slice(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/svg+xml', ext: '.svg', test: (b) => b.slice(0, 200).toString('utf8').trimStart().startsWith('<svg') },
];

export function safeName(originalName) {
  const base = path.basename(String(originalName || 'file'));
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^\w.\-+() ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const ext = path.extname(cleaned).toLowerCase();
  const stem = cleaned.slice(0, cleaned.length - (ext.length || 0)).slice(0, 90) || 'file';
  return { name: `${stem}${ext}`, ext: ext || '' };
}

export function detectSignature(buffer) {
  for (const sig of SIGNATURES) if (sig.test(buffer)) return sig;
  return null;
}

export function validateUpload({ buffer, originalName, kind = 'image', maxBytes }) {
  if (!buffer || !buffer.length) throw badRequest('Uploaded file is empty');
  const limit = maxBytes || (kind === 'image' ? config.uploads.maxImageBytes : config.uploads.maxDocBytes);
  if (buffer.length > limit) throw tooLarge(`File is larger than the ${Math.round(limit / 1024 / 1024)}MB limit`);
  const { name, ext } = safeName(originalName);
  const allowedExt = kind === 'image' ? config.uploads.imageExt : [...config.uploads.docExt, ...config.uploads.imageExt];
  if (!allowedExt.includes(ext)) throw badRequest(`File type "${ext || 'unknown'}" is not allowed for ${kind} uploads`);
  const sig = detectSignature(buffer);
  if (kind === 'image') {
    if (!sig || !config.uploads.imageTypes.includes(sig.mime)) {
      throw badRequest('Only JPEG, PNG, WEBP or GIF images are accepted for photos');
    }
    return { name, ext: sig.ext, mime: sig.mime, size: buffer.length, buffer };
  }
  const isKnownDoc = sig && (sig.mime === 'application/pdf' || sig.mime === 'image/svg+xml');
  return {
    name,
    ext,
    mime: isKnownDoc ? sig.mime : 'application/octet-stream',
    size: buffer.length,
    buffer,
  };
}

function ownerDir(ownerType, ownerId) {
  const type = String(ownerType).toLowerCase().replace(/[^a-z]/g, '') || 'misc';
  const id = Number(ownerId);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid owner id');
  return path.join(config.uploadDir, type, String(id));
}

export function storeFile(ownerType, ownerId, { buffer, name, ext, mime }, { subdir = 'files' } = {}) {
  const dir = path.join(ownerDir(ownerType, ownerId), subdir);
  fs.mkdirSync(dir, { recursive: true });
  const storedName = `${crypto.randomUUID()}${ext || ''}`;
  const fullPath = path.join(dir, storedName);
  fs.writeFileSync(fullPath, buffer, { mode: 0o600 });
  return {
    stored_name: storedName,
    filename: name,
    relative_path: path.relative(config.uploadDir, fullPath).split(path.sep).join('/'),
    mime_type: mime,
    size_bytes: buffer.length,
  };
}

export function resolveStoredFile(relativePath) {
  const full = path.resolve(config.uploadDir, relativePath);
  if (!full.startsWith(path.resolve(config.uploadDir))) return null; // path traversal guard
  if (!fs.existsSync(full)) return null;
  return full;
}

export function deleteStoredFile(relativePath) {
  const full = resolveStoredFile(relativePath);
  if (!full) return false;
  fs.rmSync(full, { force: true });
  return true;
}

export async function readStoredFile(relativePath) {
  const full = resolveStoredFile(relativePath);
  if (!full) throw notFound('Stored file is missing');
  return fs.promises.readFile(full);
}

/** PNG size from header (no image library required). */
export function imageDimensions(buffer, mime) {
  try {
    if (mime === 'image/png') return { width_px: buffer.readUInt32BE(16), height_px: buffer.readUInt32BE(20) };
    if (mime === 'image/jpeg') {
      let offset = 2;
      while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1];
        const size = buffer.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height_px: buffer.readUInt16BE(offset + 5), width_px: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + size;
      }
    }
    if (mime === 'image/gif') return { width_px: buffer.readUInt16LE(6), height_px: buffer.readUInt16LE(8) };
    if (mime === 'image/webp') {
      const fourcc = buffer.slice(12, 16).toString('latin1');
      if (fourcc === 'VP8X') return { width_px: 1 + buffer.readUIntLE(24, 3), height_px: 1 + buffer.readUIntLE(27, 3) };
      if (fourcc === 'VP8 ') return { width_px: buffer.readUInt16LE(26) & 0x3fff, height_px: buffer.readUInt16LE(28) & 0x3fff };
      if (fourcc === 'VP8L') {
        const bits = buffer.readUInt32LE(21);
        return { width_px: (bits & 0x3fff) + 1, height_px: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    /* not fatal */
  }
  return { width_px: null, height_px: null };
}
