class ClusterV2HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
  statusCode;
}
export {
  ClusterV2HttpError
};
