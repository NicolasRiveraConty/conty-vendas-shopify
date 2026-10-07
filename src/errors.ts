export class IngestError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'IngestError';
    this.statusCode = statusCode;
    this.code = code;
  }
}
