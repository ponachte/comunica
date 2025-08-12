import type { MediatorHttp } from '@comunica/bus-http';
import type {
  BindingsStream,
  ComunicaDataFactory,
  FragmentSelectorShape,
  IActionContext,
  IQuerySource,
} from '@comunica/types';
import type { BindingsFactory } from '@comunica/utils-bindings-factory';
import { MetadataValidationState } from '@comunica/utils-metadata';
import type * as RDF from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import { TransformIterator, wrap } from 'asynciterator';
import { Algebra, Util } from 'sparqlalgebrajs';
import type { Operation, Ask, Update } from 'sparqlalgebrajs/lib/algebra';
import { SparqlQueryConverter } from './SparqlQueryConverter';
import { Resource, AsyncRawResourceIterator, AsyncResourceIterator } from './AsyncResourceIterator';
import { UnionIterator, EmptyIterator } from 'asynciterator';
import { RawResourceToBindingsIterator, ResourceToBindingsIterator } from './ResourceToBindingsIterator';
import { Factory } from 'sparqlalgebrajs';

export class QuerySourceGraphql implements IQuerySource {
  protected readonly selectorShape: FragmentSelectorShape;
  protected readonly schemaSelectorShape: FragmentSelectorShape;
  protected readonly schemalessSelectorShape: FragmentSelectorShape;
  public referenceValue: string;
  protected readonly source: string;

  private readonly dataFactory: ComunicaDataFactory;
  private readonly BindingsFactory: BindingsFactory;

  private readonly queryConverter: SparqlQueryConverter;

  private readonly mediatorHttp: MediatorHttp;

  public constructor(
    source: string,
    dataFactory: ComunicaDataFactory,
    bindingsFactory: BindingsFactory,
    mediator: MediatorHttp,
    schema_source: string | undefined,
    schema_context: Record<string, string> | undefined,
  ) {
    this.source = source;
    this.referenceValue = source;
    this.dataFactory = dataFactory;
    this.BindingsFactory = bindingsFactory;
    this.mediatorHttp = mediator;

    const AF = new Factory(<RDF.DataFactory> this.dataFactory);
    this.schemalessSelectorShape = {
      type: 'operation',
      operation: {
        operationType: 'pattern',
        pattern: AF.createPattern(
          this.dataFactory.variable('s'),
          this.dataFactory.variable('p'),
          this.dataFactory.variable('o'),
        ),
      },
      variablesOptional: [
        this.dataFactory.variable('s'),
        this.dataFactory.variable('p'),
        this.dataFactory.variable('o'),
      ],
    }
    this.schemaSelectorShape = {
      type: 'disjunction',
      children: [
        {
          type: 'operation',
          operation: {
            operationType: 'type',
            type: Algebra.types.JOIN
          }
        },
        {
          type: 'operation',
          operation: {
            operationType: 'type',
            type: Algebra.types.BGP
          }
        },
        this.schemalessSelectorShape,        
      ]
    };

    if (schema_context && schema_source) {
      this.queryConverter = new SparqlQueryConverter(this.dataFactory, schema_context, schema_source);
      this.selectorShape = this.schemaSelectorShape;
    } else {
      this.selectorShape =  this.schemalessSelectorShape;
    }
  }

  public async getSelectorShape(): Promise<FragmentSelectorShape> {
    return this.schemaSelectorShape;
  }

  public queryBindings(operation: Operation, context: IActionContext): BindingsStream {
    const patterns = QuerySourceGraphql.extractPatterns(operation);
    const variables = Util.inScopeVariables(operation);

    // convert pattern
    for (const [query, varMap] of this.queryConverter.convertOperation(patterns)) {
      try {
        const resourceIterator = this.querySource(query, context);

        const bindings: BindingsStream = new TransformIterator(async() => {
          // Convert graphql result to bindings
          const bindingsIterator = new ResourceToBindingsIterator(
            resourceIterator,
            variables,
            varMap,
            this.dataFactory,
            this.BindingsFactory,
          );

          return bindingsIterator;
        });

        bindings.setProperty('metadata', {
          state: new MetadataValidationState(),
          cardinality: { type: 'estimate', value: Number.POSITIVE_INFINITY, dataset: this.source },
          // canBeUndef always false?
          variables: variables.map(variable => ({ variable, canBeUndef: false })),
        });

        return bindings;
      } catch {
        continue;
      }
    }

    throw new Error(`No valid query conversion was found`);
  }

  private querySource(query: string, context: IActionContext): AsyncIterator<Resource> {
    return new AsyncResourceIterator(this.source, query, context, this.mediatorHttp);
  }

  public static extractPatterns(op: Algebra.Operation): Algebra.Pattern[] {
    switch (op.type) {
      case Algebra.types.PROJECT:
        return this.extractPatterns(op.input);

      case Algebra.types.BGP:
        return op.patterns;

      case Algebra.types.PATTERN:
        return [op];

      case Algebra.types.JOIN: {
        const patterns: Algebra.Pattern[] = [];

        for (const child of op.input as Algebra.Operation[]) {
          patterns.push(...this.extractPatterns(child));
        }

        return patterns;
      }

      default:
        throw new Error(`Unsupported operation type: ${op.type}`);
    }
  }

  /*
  private fetchGraphqlResults(pattern: Algebra.Pattern, context: IActionContext): AsyncIterator<Resource> {
    const subject = pattern.subject;
    const predicate = pattern.predicate;
    const object = pattern.object;

    const root = subject.termType === 'NamedNode' ? 
      `Resource(id: "${subject.value}") {` :
      `Resource { id,`;

    if (predicate.termType === 'Variable') {
      if (object.termType === 'Literal' || object.termType === 'Variable') {
        // Fetch all possible predicates
        if (subject.termType === 'NamedNode') {
          const resources = this.querySource(`Resource(id: "${subject.value}") { _predicates }`, context);

          return new UnionIterator<Resource>(resources.transform({
            autoStart: false,
            transform: (resource, done: () => void, push: (i: AsyncIterator<Resource>) => void) => {
              // Create new queries from predicates
              for (const pred of resource._predicates) {
                const query = `${root} _object(predicate: "${pred}") { _rawRDF } }`;
                const pred_resources = this.querySource(query, context);

                if (object.termType === 'Variable') {
                  push(this.mapWithPred(pred_resources, pred));
                } else if (object.termType === 'Literal') {
                  push(this.mapWithPred(this.filterOnObject(pred_resources, object.value), pred));
                }

                done();
              }
            },
          }));
        }
        if (subject.termType === 'Variable') {
          const resources = this.querySource(`Resource { id, _predicates }`, context);

          return new UnionIterator<Resource>(resources.transform({
            autoStart: false,
            transform: (resource, done: () => void, push: (i: AsyncIterator<Resource>) => void) => {
              for (const pred of resource._predicates) {
                const query = `Resource(id: "${resource.id}") { id, _object(predicate: "${pred}") { _rawRDF } }`;
                const pred_resources = this.querySource(query, context);

                if (object.termType === 'Variable') {
                  push(this.mapWithPred(pred_resources, pred));
                } else if (object.termType === 'Literal') {
                  push(this.mapWithPred(this.filterOnObject(pred_resources, object.value), pred));
                }
              }
              done();
            },
          }));
        }
      } else if (object.termType === 'NamedNode') {
        return this.querySource(`${root} _relations(id: "${object.value}") }`, context);
      }
    } else if (predicate.termType === 'NamedNode') {
      if (object.termType === 'NamedNode') {
        const query = `${root} _object(predicate: "${predicate.value}", id: "${object.value}") { _rawRDF } }`;
        return this.querySource(query, context);
      }
      if (object.termType === 'Literal' || object.termType === 'Variable') {
        const query = `${root} _object(predicate: "${predicate.value}") { _rawRDF } }`;
        const resources = this.querySource(query, context);

        if (object.termType === 'Literal') {
          return this.filterOnObject(resources, object.value);
        }
        return resources;
      }
    }

    return new EmptyIterator();
  }

  private filterOnObject(resources: AsyncIterator<Resource>, value: any): AsyncIterator<Resource> {
    resources.setProperty('estimated', true);
    return resources.map((resource: any) => {
      const filteredObjects = resource._object.filter(
        (raw: any) => !raw._rawRDF['@id'] && raw._rawRDF['@value'] === value,
      );

      return {
        ...resource,
        _object: filteredObjects,
      };
    // Filter out resources with no objects
    }).filter((resource: any) => resource._object.length > 0);
  }

  private mapWithPred(resources: AsyncIterator<Resource>, pred: string): AsyncIterator<Resource> {
    resources.setProperty('estimated', true);
    return resources.map((resource: any) => {
      const newResource = {
        ...resource,
        [pred]: resource._object,
      };
      delete newResource._object;
      return newResource;
    });
  }
    */

  public queryQuads(_operation: Operation, _context: IActionContext): AsyncIterator<RDF.Quad> {
    throw new Error('queryQuads is not implemented in QuerySourceGraphql');
  }

  public queryBoolean(_operation: Ask, _context: IActionContext): Promise<boolean> {
    throw new Error('queryBoolean is not implemented in QuerySourceGraphql');
  }

  public queryVoid(_operation: Update, _context: IActionContext): Promise<void> {
    throw new Error('queryVoid is not implemented in QuerySourceGraphql');
  }

  public toString(): string {
    return `QuerySourceGraphql(${this.referenceValue})`;
  }
}

export type IBinding = Record<string, IRI | Literal>;

export interface IRI {
  type: 'uri';
  value: string;
}

export interface Literal {
  type: 'literal';
  value: string;
  datatype?: string;
}