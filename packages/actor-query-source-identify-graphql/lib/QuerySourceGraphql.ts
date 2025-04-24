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
import { SparqlJsonParser } from 'sparqljson-parse';

export class QuerySourceGraphql implements IQuerySource {
  protected readonly selectorShape: FragmentSelectorShape;
  public referenceValue: string;
  protected readonly source: string;

  private readonly dataFactory: ComunicaDataFactory;
  private readonly BindingsFactory: BindingsFactory;
  private readonly parser: SparqlJsonParser;

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

    //
    // const AF = new Factory(<RDF.DataFactory> this.dataFactory);
    // this.selectorShape = {
    // type: 'disjunction',
    // children: [
    //     {
    //       type: 'operation',
    //       operation: {
    //         operationType: 'type',
    //         type: Algebra.types.JOIN,
    //       },
    //       joinBindings: true,
    //     },
    //     {
    //       type: 'operation',
    //       operation: {
    //         operationType: 'type',
    //         type: Algebra.types.BGP,
    //       },
    //       joinBindings: true,
    //     },
    //     {
    //       type: 'operation',
    //       operation: {
    //         operationType: 'type',
    //         type: Algebra.types.PROJECT,
    //       },
    //       joinBindings: true,
    //     },
    //     {
    //       type: 'operation',
    //       operation: {
    //         operationType: 'pattern',
    //         pattern: AF.createPattern(
    //           this.dataFactory.variable('s'),
    //           this.dataFactory.variable('p'),
    //           this.dataFactory.variable('o'),
    //         ),
    //       },
    //       variablesOptional: [
    //         this.dataFactory.variable('s'),
    //         this.dataFactory.variable('p'),
    //         this.dataFactory.variable('o'),
    //       ],
    //       joinBindings: true,
    //     }
    // ],
    // };
    //

    this.parser = new SparqlJsonParser();
  }

  public async getSelectorShape(): Promise<FragmentSelectorShape> {
    return this.selectorShape;
  }

  public queryBindings(operation: Operation, context: IActionContext): BindingsStream {
    // TODO Allow conversion in a streaming way
    const bindings: BindingsStream = new TransformIterator(async() => {
      // Extract triple pattern from operation
      // console.log(operation);
      const pattern = extractPattern(operation);

      // Fetch graphql results
      const graphqlResult = await this.fetchGraphqlResults(pattern, context);
      // Console.log(JSON.stringify(graphqlResult, null, 2));

      // Convert graphql response to sparqljson
      const sparqljson = this.parseGraphqlResults(graphqlResult, pattern);
      // Console.log(JSON.stringify(sparqljson, null, 2));

      // Parse json to bindings
      const bindings = this.parser.parseJsonResults(sparqljson).map(obj =>
        this.BindingsFactory.bindings(Object.entries(obj).map(
          ([ key, term ]) => [ this.dataFactory.variable(key), term ],
        )));

      // Wrap bindings into async iterator
      const it = wrap<RDF.Bindings>(bindings, { autoStart: false });
      it.setProperty('metadata', {
        state: new MetadataValidationState(),
        cardinality: { type: 'estimate', value: 1 },
      });

      return it;
    });

    bindings.setProperty('metadata', {
      state: new MetadataValidationState(),
      cardinality: { type: 'estimate', value: Number.POSITIVE_INFINITY, dataset: this.source },
      variables: [],
    });
    return bindings;
  }

  private async fetchGraphqlResults(pattern: Algebra.Pattern, context: IActionContext): Promise<any> {
    let result = { data: { Resource: <any[]> []}};
    const subject = pattern.subject;
    const predicate = pattern.predicate;
    const object = pattern.object;

    let root;
    if (subject.termType === 'NamedNode') {
      root = `Resource(id: "${subject.value}") {`;
    } else if (subject.termType === 'Variable') {
      root = `Resource { id,`;
    }

    if (predicate.termType === 'Variable') {
      if (object.termType === 'Literal' || object.termType === 'Variable') {
        // Fetch all possible predicates
        if (subject.termType === 'NamedNode') {
          const response = await this.querySource(`Resource(id: "${subject.value}") { _predicates }`, context);

          // Create new queries from predicates
          for (const pred of response.data.Resource[0]._predicates) {
            const query = `${root} _object(predicate: "${pred}") { _rawRDF } }`;
            const response = await this.querySource(query, context);

            if (object.termType === 'Variable') {
              result.data.Resource.push(
                ...this.mapWithPred(response.data.Resource, pred),
              );
            } else if (object.termType === 'Literal') {
              result.data.Resource.push(
                ...this.mapWithPred(this.filterOnObject(response.data.Resource, object.value), pred),
              );
            }
          }
        } else if (subject.termType === 'Variable') {
          const response = await this.querySource(`Resource { id, _predicates }`, context);

          // Create new queries from predicates
          for (const resource of response.data.Resource) {
            for (const pred of resource._predicates) {
              const query = `Resource(id: "${resource.id}") { id, _object(predicate: "${pred}") { _rawRDF } }`;
              const response = await this.querySource(query, context);

              if (object.termType === 'Variable') {
                result.data.Resource.push(
                  ...this.mapWithPred(response.data.Resource, pred),
                );
              } else if (object.termType === 'Literal') {
                result.data.Resource.push(
                  ...this.mapWithPred(this.filterOnObject(response.data.Resource, object.value), pred),
                );
              }
            }
          }
        }
      } else if (object.termType === 'NamedNode') {
        result = await this.querySource(`${root} _relations(id: "${object.value}") }`, context);
      }
    } else if (predicate.termType === 'NamedNode') {
      if (object.termType === 'NamedNode') {
        const query = `${root} _object(predicate: "${predicate.value}", id: "${object.value}") { _rawRDF } }`;
        result = await this.querySource(query, context);
      } else if (object.termType === 'Literal' || object.termType === 'Variable') {
        const query = `${root} _object(predicate: "${predicate.value}") { _rawRDF } }`;
        const response = await this.querySource(query, context);

        if (object.termType === 'Literal') {
          result.data.Resource.push(...this.filterOnObject(response.data.Resource, object.value));
        } else {
          result = response;
        }
      }
    }

    return result;
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

  private async querySource(query: any, context: IActionContext): Promise<any> {
    const body = {
      '@context': {},
      query: `query { ${query} }`,
    };

    const init: RequestInit = {
      headers: new Headers({
        'Content-Type': 'application/json',
      }),
      method: 'POST',
      body: JSON.stringify(body, null, 2),
    };

    // Fetch the results
    const response = await this.mediatorHttp.mediate({
      input: this.source,
      init,
      context,
    }).then(response => response.json());
    return response;
  }

  private filterOnObject(resources: any, value: any): any {
    return resources.map((resource: any) => {
      const filteredObjects = resource._object.filter(
        (raw: any) => !(raw._rawRDF['@id'] || value !== raw._rawRDF['@value']),
      );

      return {
        ...resource,
        _object: filteredObjects,
      };
    // Filter out resources with no objects
    }).filter((resource: any) => resource._object.length > 0);
  }

  private mapWithPred(resources: any, pred: string): any {
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
