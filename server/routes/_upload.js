/** Multer instance shared by all upload endpoints (memory storage + strict limits). */
import multer from 'multer';
import config from '../config.js';

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Math.max(config.uploads.maxDocBytes, config.uploads.maxImageBytes),
    files: 12,
    fields: 40,
  },
});

export const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxImageBytes, files: 12 },
});
