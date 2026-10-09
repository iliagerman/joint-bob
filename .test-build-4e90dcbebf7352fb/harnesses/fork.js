class HarnessForkError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
}
export {
  HarnessForkError
};
