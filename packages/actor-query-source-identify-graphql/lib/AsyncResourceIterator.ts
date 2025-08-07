import type { MediatorHttp } from '@comunica/bus-http';
import type { IActionContext } from '@comunica/types';
import { BufferedIterator } from 'asynciterator';

export type Resource = Record<string, any>;

function flattenResponse(obj: any, prefix = ''): Resource[] {
  if (Array.isArray(obj)) {
    // Flatten each item in the array and combine results
    return obj.flatMap(item => flattenResponse(item, prefix));
  }

  if (typeof obj !== 'object' || obj === null) {
    // Primitive value — wrap in an object
    return [{ [prefix]: obj }];
  }

  const entries: Resource[] = [{}];

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}_${key}` : key;
    const flattened = flattenResponse(value, fullKey);

    // Combine each flattened result with the existing entries
    const combined: Resource[] = [];

    for (const entry of entries) {
      for (const flat of flattened) {
        combined.push({ ...entry, ...flat });
      }
    }

    entries.splice(0, entries.length, ...combined); // Replace entries
  }

  return entries;
}

export class AsyncResourceIterator extends BufferedIterator<Resource> {
  private readonly source: string;
  private query: string;
  private readonly context: IActionContext;
  private readonly mediatorHttp: MediatorHttp;
  private cursor: string | null = null;

  public constructor(
    source: string,
    query: string,
    context: IActionContext,
    mediatorHttp: MediatorHttp,
  ) {
    super({ maxBufferSize: Number.POSITIVE_INFINITY, autoStart: false });
    this.source = source;
    this.query = query;
    this.context = context;
    this.mediatorHttp = mediatorHttp;
  }

  protected override async _read(_count: number, done: () => void): Promise<void> {
    try {
      const response = await this._query(this.query);

      const resources: Resource[] = flattenResponse(response?.data) ?? [];
      for (const resource of resources) {
        this._push(resource);
      }

      // TODO: Handle pagination
      const pagination = response.extensions?.pagination?.[0];
      if (pagination?.next) {
        this.cursor = pagination.next;
        this.query = this._updateQueryWithCursor(this.cursor!);
      } else {
        this.cursor = null;
        this.close();
      }
    } catch (err) {
      this.emit('error', err);
      this.close();
    } finally {
      done();
    }
  }

  private _query(query: string): Promise<any> {
    const body = {
      '@context': {},
      query: `query { ${query} }`,
    };

    const init: RequestInit = {
      headers: new Headers({ 'Content-Type': 'application/json' }),
      method: 'POST',
      body: JSON.stringify(body),
    };

    return this.mediatorHttp.mediate({
      input: this.source,
      init,
      context: this.context,
    }).then(response => response.json());
  }

  private _updateQueryWithCursor(newCursor: string, newPageSize: number | null = null): string {
    return this.query.replace(
      /(\bResource)(\s*\(([^)]*)\))?\s*\{([^]*)\}/u,
      (_match, resourceKeyword, _fullParams, innerParams, selectionSet) => {
        const paramMap: Record<string, string> = {};

        if (innerParams?.trim()) {
          for (const pair of innerParams.split(',')) {
            const [ key, value ] = pair.split(':').map((s: string) => s.trim());
            paramMap[key] = value;
          }
        }

        paramMap.cursor = `"${newCursor}"`;

        if (newPageSize) {
          paramMap.newPageSize = `"${newPageSize}"`;
        }

        const newParams = Object.entries(paramMap)
          .map(([ k, v ]) => `${k}: ${v}`)
          .join(', ');

        return `${resourceKeyword}(${newParams}) {${selectionSet}}`;
      },
    );
  }
}

export class AsyncRawResourceIterator extends BufferedIterator<Resource> {
  private readonly source: string;
  private query: string;
  private readonly context: IActionContext;
  private readonly mediatorHttp: MediatorHttp;
  private cursor: string | null = null;

  public constructor(
    source: string,
    query: string,
    context: IActionContext,
    mediatorHttp: MediatorHttp,
  ) {
    super({ maxBufferSize: Number.POSITIVE_INFINITY, autoStart: false });
    this.source = source;
    this.query = query;
    this.context = context;
    this.mediatorHttp = mediatorHttp;

    this.setProperty('estimated', false);
  }

  protected override async _read(_count: number, done: () => void): Promise<void> {
    try {
      const response = await this._query(this.query);

      const resources: Resource[] = response?.data?.Resource ?? [];
      for (const resource of resources) {
        this._push(resource);
      }

      // TODO: Handle pagination on other points then entrypoint
      const pagination = response.extensions?.pagination?.[0];
      if (pagination?.next) {
        this.cursor = pagination.next;
        this.query = this._updateQueryWithCursor(this.cursor!);
      } else {
        this.cursor = null;
        this.close();
      }
    } catch (err) {
      this.emit('error', err);
      this.close();
    } finally {
      done();
    }
  }

  private _query(query: string): Promise<any> {
    const body = {
      '@context': {},
      query: `query { ${query} }`,
    };

    const init: RequestInit = {
      headers: new Headers({ 'Content-Type': 'application/json' }),
      method: 'POST',
      body: JSON.stringify(body),
    };

    return this.mediatorHttp.mediate({
      input: this.source,
      init,
      context: this.context,
    }).then(response => response.json());
  }

  private _updateQueryWithCursor(newCursor: string, newPageSize: number | null = null): string {
    return this.query.replace(
      /(\bResource)(\s*\(([^)]*)\))?\s*\{([^]*)\}/u,
      (_match, resourceKeyword, _fullParams, innerParams, selectionSet) => {
        const paramMap: Record<string, string> = {};

        if (innerParams?.trim()) {
          for (const pair of innerParams.split(',')) {
            const [ key, value ] = pair.split(':').map((s: string) => s.trim());
            paramMap[key] = value;
          }
        }

        paramMap.cursor = `"${newCursor}"`;

        if (newPageSize) {
          paramMap.newPageSize = `"${newPageSize}"`;
        }

        const newParams = Object.entries(paramMap)
          .map(([ k, v ]) => `${k}: ${v}`)
          .join(', ');

        return `${resourceKeyword}(${newParams}) {${selectionSet}}`;
      },
    );
  }
}