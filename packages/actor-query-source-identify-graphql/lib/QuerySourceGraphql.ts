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
import { Algebra, Factory } from 'sparqlalgebrajs';
import type { Operation, Ask, Update } from 'sparqlalgebrajs/lib/algebra';
import { SparqlQueryConverter } from './SparqlConverter';
import { Resource, AsyncResourceIterator } from './AsyncResourceIterator';
import { UnionIterator, EmptyIterator } from 'asynciterator';
import { getVariables } from '@comunica/bus-query-source-identify';
import { ResourceToBindingsIterator } from './ResourceToBindingsIterator';

const SCHEMA_SOURCE = `
type Query {
  persons: [foaf_Person!]!
}

type foaf_Person {
  id: ID!
  ex_knows: foaf_Person!
  schema_email: String!
  schema_givenName: String!
}
`

const SCHEMA_CONTEXT = {
  "kss": "https://kvasir.discover.ilabt.imec.be/vocab#",
  "ex": "http://example.org/",
  "foaf": "http://xmlns.com/foaf/0.1/",
  "schema": "http://schema.org/"
};

export class QuerySourceGraphql implements IQuerySource {
  protected readonly selectorShape: FragmentSelectorShape;
  public referenceValue: string;
  protected readonly source: string;

  private readonly dataFactory: ComunicaDataFactory;
  private readonly BindingsFactory: BindingsFactory;
  private readonly queryConverter: SparqlQueryConverter = new SparqlQueryConverter(SCHEMA_SOURCE);

  private readonly mediatorHttp: MediatorHttp;

  public constructor(
    source: string,
    dataFactory: ComunicaDataFactory,
    bindingsFactory: BindingsFactory,
    mediator: MediatorHttp,
  ) {
    this.source = source;
    this.referenceValue = source;
    this.dataFactory = dataFactory;
    this.BindingsFactory = bindingsFactory;
    this.mediatorHttp = mediator;

    const AF = new Factory(<RDF.DataFactory> this.dataFactory);
    this.selectorShape = {
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
    };
  }

  public async getSelectorShape(): Promise<FragmentSelectorShape> {
    return this.selectorShape;
  }

  public queryBindings(operation: Operation, context: IActionContext): BindingsStream {
    if (operation.type !== 'pattern') {
      throw new Error(`Attempted to pass non-pattern operation '${operation.type}' to QuerySourceGraphql`);
    }

    if (operation.predicate.termType === 'Variable') {
      throw new Error(`Attempted to pass pattern operation with variable predicate to QuerySourceGraphql`);
    }

    // Extract triple pattern from operation
    const pattern = extractPattern(operation);

    // Fetch graphql results
    const resourceIterator = this.fetchGraphqlResults(pattern, context);

    const bindings: BindingsStream = new TransformIterator(async() => {
      // Convert graphql result to bindings
      const bindingsIterator = new ResourceToBindingsIterator(
        resourceIterator,
        pattern,
        this.dataFactory,
        this.BindingsFactory,
      );

      return bindingsIterator;
    });

    bindings.setProperty('metadata', {
      state: new MetadataValidationState(),
      cardinality: { type: 'estimate', value: Number.POSITIVE_INFINITY, dataset: this.source },
      variables: getVariables(pattern).map(variable => ({ variable, canBeUndef: false })),
    });

    return bindings;
  }

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

  private parseGraphqlResults(result: any, pattern: Algebra.Pattern): any {
    const sparqljson = {
      head: { vars: <string[]> []},
      results: { bindings: <IBinding[]> []},
    };
    const subject = pattern.subject;
    const predicate = pattern.predicate;
    const object = pattern.object;

    for (const _subj of result.data.Resource) {
      const binding: IBinding | undefined = {};

      if (subject.termType === 'Variable') {
        sparqljson.head.vars.push(subject.value);
        binding[subject.value] = {
          type: 'uri',
          value: _subj.id,
        };
      }

      if (_subj._relations) {
        sparqljson.head.vars.push(predicate.value);
        for (const _pred of _subj._relations) {
          binding[predicate.value] = {
            type: 'uri',
            value: _pred,
          };
          sparqljson.results.bindings.push(binding);
        }
      } else {
        for (const _pred of Object.keys(_subj)) {
          if (_pred === 'id') {
            continue;
          }

          if (predicate.termType === 'Variable') {
            sparqljson.head.vars.push(predicate.value);
            binding[predicate.value] = {
              type: 'uri',
              value: _pred,
            };
          }

          for (const _obj of _subj[_pred]) {
            // Convert rawRDF result to SPARQL result
            if (object.termType === 'Variable') {
              sparqljson.head.vars.push(object.value);
              if (_obj._rawRDF['@id']) {
                binding[object.value] = {
                  type: 'uri',
                  value: _obj._rawRDF['@id'],
                };
              } else {
                binding[object.value] = {
                  type: 'literal',
                  value: _obj._rawRDF['@value'],
                  datatype: _obj._rawRDF['@type'],
                };
              }
            }
            sparqljson.results.bindings.push(binding);
          }
        }
      }
    }

    return sparqljson;
  }

  private querySource(query: string, context: IActionContext): AsyncResourceIterator {
    return new AsyncResourceIterator(this.source, query, context, this.mediatorHttp);
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

export function extractPattern(operation: Algebra.Operation): Algebra.Pattern {
  switch (operation.type) {
    case Algebra.types.PROJECT: {
      return extractPattern(operation.input);
    }
    case Algebra.types.BGP: {
      const patterns = (operation).patterns;
      if (patterns.length === 1) {
        return patterns[0];
      }
      throw new Error(`More then one pattern present: ${patterns.length}`);
    }
    case Algebra.types.PATTERN: {
      return operation;
    }
    default: {
      throw new Error(`Unsupported operation type: ${operation.type}`);
    }
  }
}
