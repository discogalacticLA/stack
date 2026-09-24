export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export const notFound = (what = "Page") => new HttpError(404, `${what} not found`);
export const forbidden = (msg = "You don't have permission to do that.") => new HttpError(403, msg);

/** A business-rule failure that should be shown to the user (usually 409/422). */
export class DomainError extends Error {
  constructor(message: string, public status = 409) {
    super(message);
  }
}
