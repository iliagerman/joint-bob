/** Something the caller may not see answers exactly as if it didn't exist. */
export class NotFoundError extends Error {
  readonly statusCode = 404;
}
