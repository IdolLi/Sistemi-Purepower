/** HTTP error helpers + async route wrapper. */

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (details) this.details = details;
  }
}

export const badRequest = (msg = 'Invalid request', details) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, msg);
export const forbidden = (msg = 'You do not have permission for this action') => new HttpError(403, msg);
export const notFound = (msg = 'Record not found') => new HttpError(404, msg);
export const conflict = (msg = 'Record conflict', details) => new HttpError(409, msg, details);
export const tooLarge = (msg = 'Uploaded file is too large') => new HttpError(413, msg);
export const tooMany = (msg = 'Too many requests, slow down') => new HttpError(429, msg);

/** Wrap an async express handler so rejections become 500s instead of hanging requests. */
export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Error thrown by services when a unique constraint is violated. */
export function isDuplicateError(err) {
  const msg = String(err?.message || '');
  return err?.code === 'ER_DUP_ENTRY' || /duplicate entry/i.test(msg) || /UNIQUE constraint/i.test(msg);
}

export function isForeignKeyError(err) {
  const msg = String(err?.message || '');
  return err?.code === 'ER_ROW_IS_REFERENCED_2' || err?.code === 'ER_NO_REFERENCED_ROW_2' || /foreign key constraint/i.test(msg);
}
