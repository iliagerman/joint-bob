export class ClusterV2HttpError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
