/** Demande refusée par le relais (ou par Atlantic), avec un code et un message en français. */
export class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}
