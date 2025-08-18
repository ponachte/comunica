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

  for (const [ key, value ] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}_${key}` : key;
    const flattened = flattenResponse(value, fullKey);

    // Combine each flattened result with the existing entries
    const combined: Resource[] = [];

    for (const entry of entries) {
      for (const flat of flattened) {
        combined.push({ ...entry, ...flat });
      }
    }

    // Replace entries
    entries.splice(0, entries.length, ...combined);
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
          const currentDepth = current.path.split('/').filter(Boolean).length;
          const deepestDepth = deepest.path.split('/').filter(Boolean).length;
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

  private async _query(query: string): Promise<any> {
    const body = {
      '@context': {},
      query: `query { ${query} }`,
    };

    const init: RequestInit = {
      headers: new Headers({ 'Content-Type': 'application/json' }),
      method: 'POST',
      body: JSON.stringify(body),
    };

    const response = await this.mediatorHttp.mediate({
      input: this.source,
      init,
      context: this.context,
    });

    if (!response.ok) {
      // Try to read the body for extra error info
      let errorBody: any;
      try {
        errorBody = await response.text();
      } catch {
        errorBody = '<no body>';
      }

      throw new Error(`HTTP ${response.status} ${response.statusText}: ${errorBody}`);
    }

    return await response.json();
  }

  private _updateCursorInQuery(query: string, path: string, newCursor: string): string {
    const pathParts = path.replace(/^\/+/u, '').split('/');

    function insertCursorAtField(source: string, parts: string[], depth = 0): string {
      const field = parts[0];
      let index = 0;
      let inString = false;

      while (index < source.length) {
        const char = source[index];

        // Handle string quotes properly (avoid modifying inside strings)
        if (char === '"') {
          inString = !inString;
          index++;
          continue;
        }

        if (!inString && new RegExp(`^\\b${field}\\b`, 'u').test(source.slice(index))) {
          const matchStart = index;
          const matchEnd = index + field.length;

          // Check for arguments
          let argsStart = -1;
          let argsEnd = -1;
          let bodyStart = -1;

          index = matchEnd;

          // Skip whitespace
          while (/\s/u.test(source[index])) {
            index++;
          }

          // Check for arguments
          if (source[index] === '(') {
            argsStart = index;
            let parenCount = 1;
            index++;
            while (index < source.length && parenCount > 0) {
              if (source[index] === '(') {
                parenCount++;
              } else if (source[index] === ')') {
                parenCount--;
              }
              index++;
            }
            argsEnd = index;
          }

          // Skip whitespace
          while (/\s/u.test(source[index])) {
            index++;
          }

          // Check for body
          if (source[index] === '{') {
            bodyStart = index;
          }

          // We’re at the right depth
          if (parts.length === 1) {
            let updatedField = '';

            if (argsStart === -1) {
              // No args, add cursor
              updatedField = `${field}(cursor: "${newCursor}")`;
            } else {
              // Update existing args
              const argsStr = source.slice(argsStart + 1, argsEnd - 1)
                .split(',')
                .map(arg => arg.trim())
                .filter(arg => !arg.startsWith('cursor:'));
              argsStr.push(`cursor: "${newCursor}"`);
              updatedField = `${field}(${argsStr.join(', ')})`;
            }

            return source.slice(0, matchStart) + updatedField + source.slice(index);
          }

          // Recurse into the nested block
          if (bodyStart !== -1) {
            let braceCount = 1;
            let bodyEnd = bodyStart + 1;
            while (bodyEnd < source.length && braceCount > 0) {
              if (source[bodyEnd] === '{') {
                braceCount++;
              } else if (source[bodyEnd] === '}') {
                braceCount--;
              }
              bodyEnd++;
            }

            const before = source.slice(0, bodyStart + 1);
            const body = source.slice(bodyStart + 1, bodyEnd - 1);
            const after = source.slice(bodyEnd - 1);

            const newBody = insertCursorAtField(body, parts.slice(1), depth + 1);
            return before + newBody + after;
          }
        }

        index++;
      }

      return source;
    }

    return insertCursorAtField(query, pathParts);
  }
}
