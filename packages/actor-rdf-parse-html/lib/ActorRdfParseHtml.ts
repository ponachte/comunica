import type { IActionRdfParse, IActorRdfParseFixedMediaTypesArgs, IActorRdfParseOutput } from '@comunica/bus-rdf-parse';
import {
  ActorRdfParseFixedMediaTypes,
} from '@comunica/bus-rdf-parse';
import type {
  IActionRdfParseHtml,
  IActorRdfParseHtmlOutput,
  IHtmlParseListener,
} from '@comunica/bus-rdf-parse-html';
import type { Actor, Bus, IActorTest } from '@comunica/core';
import type { IActionContext } from '@comunica/types';
import type * as RDF from '@rdfjs/types';
import { Parser } from 'htmlparser2';
import { Readable } from 'readable-stream';

/**
 * A comunica HTML RDF Parse Actor.
 * It creates an HTML parser, and delegates its events via the bus-rdf-parse-html bus to other HTML parsing actors.
 */
export class ActorRdfParseHtml extends ActorRdfParseFixedMediaTypes {
  private readonly busRdfParseHtml: Bus<Actor<
    IActionRdfParseHtml,
    IActorTest,
    IActorRdfParseHtmlOutput,
    undefined
  >, IActionRdfParseHtml, IActorTest, IActorRdfParseHtmlOutput>;

  /**
   * @param args -
   *   \ @defaultNested {{
   *       "text/html": 1.0,
   *       "application/xhtml+xml": 0.9
   *     }} mediaTypePriorities
   *   \ @defaultNested {{
   *       "text/html": "http://www.w3.org/ns/formats/HTML",
   *       "application/xhtml+xml": "http://www.w3.org/ns/formats/HTML"
   *     }} mediaTypeFormats
   */
  public constructor(args: IActorRdfParseHtmlArgs) {
    super(args);
  }

  public async runHandle(action: IActionRdfParse, mediaType: string, context: IActionContext):
  Promise<IActorRdfParseOutput> {
    const data = new Readable({ objectMode: true });
    data._read = () => {
      // Do nothing
    };

    let maxSize = 0;

    // Create callbacks action
    let endBarrier = 1;
    function error(subError: unknown): void {
      data.emit('error', subError);
    }
    function end(): void {
      if (--endBarrier === 0) {
        data.push(null);
      }
    }
    const htmlAction: IActionRdfParseHtml = {
      baseIRI: action.metadata?.baseIRI ?? '',
      context,
      emit: (quad: RDF.Quad) => {
        maxSize--;
        data.push(quad);
      },
      end,
      error,
      headers: action.headers,
    };

    try {
      const outputs = await Promise.all(this.busRdfParseHtml.publish(htmlAction));
      endBarrier += outputs.length;

      const htmlParseListeners: IHtmlParseListener[] = [];
      for (const output of outputs) {
        // eslint-disable-next-line unicorn/no-useless-undefined
        const { htmlParseListener } = await output.actor.run(htmlAction, undefined);
        htmlParseListeners.push(htmlParseListener);
      }

      // Create parser
      const parser = new Parser({
        onclosetag() {
          try {
            for (const htmlParseListener of htmlParseListeners) {
              htmlParseListener.onTagClose();
            }
          } catch (error_: unknown) {
            error(error_);
          }
        },
        onend() {
          try {
            for (const htmlParseListener of htmlParseListeners) {
              htmlParseListener.onEnd();
            }
          } catch (error_: unknown) {
            error(error_);
          }
          end();
        },
        onopentag(name: string, attributes: Record<string, string>) {
          try {
            for (const htmlParseListener of htmlParseListeners) {
              htmlParseListener.onTagOpen(name, attributes);
            }
          } catch (error_: unknown) {
            error(error_);
          }
        },
        ontext(text: string) {
          try {
            for (const htmlParseListener of htmlParseListeners) {
              htmlParseListener.onText(text);
            }
          } catch (error_: unknown) {
            error(error_);
          }
        },
      }, {
        decodeEntities: true,
        recognizeSelfClosing: true,
        xmlMode: false,
      });

      const read = data._read = (size: number) => {
        maxSize = Math.max(size, maxSize);
        // eslint-disable-next-line no-unmodified-loop-condition
        while (maxSize > 0) {
          const item = action.data.read();
          if (item === null) {
            action.data.once('readable', () => read(0));
            return;
          }
          parser.write(item.toString());
        }
      };

      action.data
        .on('error', error)
        .on('end', () => parser.end());
    } catch (e) {
      setTimeout(() => {
        data.emit('error', e);
      });
    }

    return { data };
  }
}

export interface IActorRdfParseHtmlArgs extends IActorRdfParseFixedMediaTypesArgs {
  /* eslint-disable max-len */
  /**
   * The RDF Parse HTML bus for fetching HTML listeners
   * @default {<npmd:@comunica/bus-rdf-parse-html/^4.0.0/components/ActorRdfParseHtml.jsonld#ActorRdfParseHtml_default_bus>}
   */
  busRdfParseHtml: Bus<Actor<IActionRdfParseHtml, IActorTest, IActorRdfParseHtmlOutput, undefined>, IActionRdfParseHtml, IActorTest, IActorRdfParseHtmlOutput>;
  /* eslint-enable max-len */
}
