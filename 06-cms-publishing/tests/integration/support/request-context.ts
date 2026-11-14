type CookieOptions = Record<string, unknown>;

/** Stand-in for the cookie store `next/headers` exposes inside a request. */
export class CookieJar {
  private readonly values = new Map<string, string>();
  readonly lastOptions = new Map<string, CookieOptions | undefined>();

  get(name: string): { name: string; value: string } | undefined {
    const value = this.values.get(name);
    return value === undefined ? undefined : { name, value };
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  set(name: string, value: string, options?: CookieOptions): void {
    this.values.set(name, value);
    this.lastOptions.set(name, options);
  }

  delete(name: string): void {
    this.values.delete(name);
  }

  clear(): void {
    this.values.clear();
    this.lastOptions.clear();
  }
}

export const requestContext = {
  cookies: new CookieJar(),
  headers: new Headers(),
  draftMode: {
    isEnabled: false,
    enable(): void {
      requestContext.draftMode.isEnabled = true;
    },
    disable(): void {
      requestContext.draftMode.isEnabled = false;
    },
  },
};

export function resetRequestContext(): void {
  requestContext.cookies.clear();
  requestContext.headers = new Headers();
  requestContext.draftMode.isEnabled = false;
}
