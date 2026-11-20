export class ApplicationError extends Error {
  override readonly name = "ApplicationError";

  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly publicDetail: string,
    readonly type = "about:blank",
  ) {
    super(publicDetail);
  }
}
