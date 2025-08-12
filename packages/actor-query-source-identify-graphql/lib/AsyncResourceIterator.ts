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
      while (_count > 0) {
        // Fetch graphql query results
        const response = await this._query(this.query);

        if (!response) {
          this.close();
          break;
        }

        // Extract resources from results
        const resources: Resource[] = flattenResponse(response.data);
        for (const resource of resources) {
          this._push(resource);
        }
        _count -= resources.length;
      
        // Check if there are more resources available
        const paginations = response?.extensions?.pagination?.filter((p: any) => p?.next);

        if (!paginations || paginations.length === 0) {
          this.close();
          break;
        }

        // Find the pagination with the deepest path
        const deepestPagination = paginations.reduce((deepest: any, current: any) => {
          const currentDepth = current.path.split("/").filter(Boolean).length;
          const deepestDepth = deepest.path.split("/").filter(Boolean).length;
          return currentDepth > deepestDepth ? current : deepest;
        });

        // Update query with cursor
        this.query = this._updateCursorInQuery(this.query, deepestPagination.path, deepestPagination.next);

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

  private _updateCursorInQuery(query: string, path: string, newCursor: string): string {
    const pathParts = path.replace(/^\/+/, "").split("/"); // ['persons', 'ex_knows', 'schema_givenName']

    function insertCursorAtField(source: string, parts: string[], depth = 0): string {
      const field = parts[0];
      let index = 0;
      let openBraces = 0;
      let inString = false;
      let output = "";

      while (index < source.length) {
          const char = source[index];

          // Handle string quotes properly (avoid modifying inside strings)
          if (char === '"') {
              inString = !inString;
              output += char;
              index++;
              continue;
          }

          if (!inString && source.slice(index).match(new RegExp(`^\\b${field}\\b`))) {
              const matchStart = index;
              const matchEnd = index + field.length;

              // Check for arguments
              let argsStart = -1;
              let argsEnd = -1;
              let bodyStart = -1;

              index = matchEnd;

              // Skip whitespace
              while (/\s/.test(source[index])) index++;

              // Check for arguments
              if (source[index] === "(") {
                  argsStart = index;
                  let parenCount = 1;
                  index++;
                  while (index < source.length && parenCount > 0) {
                      if (source[index] === "(") parenCount++;
                      else if (source[index] === ")") parenCount--;
                      index++;
                  }
                  argsEnd = index;
              }

              // Skip whitespace
              while (/\s/.test(source[index])) index++;

              // Check for body
              if (source[index] === "{") {
                  bodyStart = index;
              }

              // We’re at the right depth
              if (parts.length === 1) {
                  const originalField = source.slice(matchStart, index);
                  let updatedField = "";

                  if (argsStart !== -1) {
                      // Update existing args
                      const argsStr = source.slice(argsStart + 1, argsEnd - 1)
                          .split(",")
                          .map(arg => arg.trim())
                          .filter(arg => !arg.startsWith("cursor:"));
                      argsStr.push(`cursor: "${newCursor}"`);
                      updatedField = `${field}(${argsStr.join(", ")})`;
                  } else {
                      // No args, add cursor
                      updatedField = `${field}(cursor: "${newCursor}")`;
                  }

                  return source.slice(0, matchStart) + updatedField + source.slice(index);
              }

              // Recurse into the nested block
              if (bodyStart !== -1) {
                  let braceCount = 1;
                  let bodyEnd = bodyStart + 1;
                  while (bodyEnd < source.length && braceCount > 0) {
                      if (source[bodyEnd] === "{") braceCount++;
                      else if (source[bodyEnd] === "}") braceCount--;
                      bodyEnd++;
                  }

                  const before = source.slice(0, bodyStart + 1);
                  const body = source.slice(bodyStart + 1, bodyEnd - 1);
                  const after = source.slice(bodyEnd - 1);

                  const newBody = insertCursorAtField(body, parts.slice(1), depth + 1);
                  return before + newBody + after;
              }
          }

          output += char;
          index++;
      }

      return source;
    }

    return insertCursorAtField(query, pathParts);
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