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
import { TransformIterator, EmptyIterator } from 'asynciterator';
import { Algebra, Util, Factory } from 'sparqlalgebrajs';
import type { Operation, Ask, Update } from 'sparqlalgebrajs/lib/algebra';
import type { Resource } from './AsyncResourceIterator';
import { AsyncResourceIterator } from './AsyncResourceIterator';
import { ResourceToBindingsIterator } from './ResourceToBindingsIterator';
import { SparqlQueryConverter } from './SparqlQueryConverter';

export class QuerySourceGraphql implements IQuerySource {
  protected readonly selectorShape: FragmentSelectorShape;
  protected readonly schemaSelectorShape: FragmentSelectorShape;
  protected readonly tripleSelectorShape: FragmentSelectorShape;
  public referenceValue: string;
  protected readonly source: string;

  private readonly dataFactory: ComunicaDataFactory;
  private readonly BindingsFactory: BindingsFactory;

  private readonly queryConverter: SparqlQueryConverter | undefined;
  private readonly mediatorHttp: MediatorHttp;

  // New: store the chosen conversion method
  private readonly queryConversion: (
    op: Operation,
    ctx: IActionContext,
  ) => [AsyncIterator<Resource>, Record<string, string>];

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
    this.tripleSelectorShape = {
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
    this.schemaSelectorShape = {
      type: 'disjunction',
      children: [
        {
          type: 'operation',
          operation: {
            operationType: 'type',
            type: Algebra.types.JOIN,
          },
        },
        {
          type: 'operation',
          operation: {
            operationType: 'type',
            type: Algebra.types.BGP,
          },
        },
        this.tripleSelectorShape,
      ],
    };

    // Decide schema or schemaless once
    if (schema_context && schema_source) {
      this.queryConverter = new SparqlQueryConverter(
        this.dataFactory,
        schema_context,
        schema_source,
      );
      this.selectorShape = this.schemaSelectorShape;
      this.queryConversion = this.schemaQueryConversion.bind(this);
    } else {
      this.selectorShape = this.tripleSelectorShape;
      this.queryConversion = this.schemalessQueryConversion.bind(this);
    }
  }

  public async getSelectorShape(): Promise<FragmentSelectorShape> {
    return this.selectorShape;
  }

  public queryBindings(operation: Operation, context: IActionContext): BindingsStream {
    const variables = Util.inScopeVariables(operation);

    // Call pre-selected conversion function
    const [ resourceIterator, varMap ] = this.queryConversion(operation, context);

    const bindings: BindingsStream = new TransformIterator(async() => {
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
      cardinality: {
        type: 'estimate',
        value: Number.POSITIVE_INFINITY,
        dataset: this.source,
      },
      variables: variables.map(variable => ({ variable, canBeUndef: false })),
    });

    return bindings;
  }

  private schemaQueryConversion(
    operation: Algebra.Operation,
    context: IActionContext,
  ): [AsyncIterator<Resource>, Record<string, string>] {
    function extractPatterns(op: Algebra.Operation): Algebra.Pattern[] {
      switch (op.type) {
        case Algebra.types.PROJECT:
          return extractPatterns(op.input);
        case Algebra.types.BGP:
          return op.patterns;
        case Algebra.types.PATTERN:
          return [ op ];
        case Algebra.types.JOIN: {
          const patterns: Algebra.Pattern[] = [];
          for (const child of op.input) {
            patterns.push(...extractPatterns(child));
          }
          return patterns;
        }
        default:
          throw new Error(`Unsupported operation type: ${op.type}`);
      }
    }

    const patterns = extractPatterns(operation);

    for (const [ query, varMap ] of this.queryConverter!.convertOperation(patterns)) {
      try {
        return [ this.querySource(query, context), varMap ];
      } catch {
        continue;
      }
    }

    return [ new EmptyIterator(), {}];
  }

  private schemalessQueryConversion(
    operation: Algebra.Operation,
    context: IActionContext,
  ): [AsyncIterator<Resource>, Record<string, string>] {
    if (operation.type !== 'pattern') {
      throw new Error(`Attempted to give non-pattern operation ${operation.type} to QuerySourceGraphql`);
    }

    if (operation.predicate.termType === 'Variable') {
      throw new Error(`Attempted to give pattern with variable predicate to QuerySourceGraphql`);
    }

    const varMap: Record<string, string> = {};
    const subject = operation.subject;
    const predicate = operation.predicate;
    const object = operation.object;

    let query = 'Resource';
    if (subject.termType === 'NamedNode') {
      query += `(id: "${subject.value}")`;
    }
    query += ' { ';

    if (subject.termType === 'Variable') {
      query += 'id ';
      varMap[subject.value] = 'Resource_id';
    }

    if (object.termType === 'NamedNode') {
      query += `_object(predicate: "${predicate.value}", id: "${object.value}") { _rawRDF } }`;
      return [ this.querySource(query, context), varMap ];
    }
    if (object.termType === 'Literal' || object.termType === 'Variable') {
      query += `_object(predicate: "${predicate.value}") { _rawRDF } }`;
      const resources = this.querySource(query, context);

      if (object.termType === 'Literal') {
        return [
          resources.filter(r => r['Resource__object__rawRDF_@value'] === object.value),
          varMap,
        ];
      }
      // Change the rawRDF variable
      varMap[object.value] = 'obj';
      return [
        resources.map((resource) => {
          const idVal = resource['Resource__object__rawRDF_@id'];
          const valueVal = resource['Resource__object__rawRDF_@value'];

          return <Resource>{
            ...resource,
            obj: idVal ?? valueVal,
          };
        }),
        varMap,
      ];
    }

    return [ new EmptyIterator(), varMap ];
  }

  private querySource(
    query: string,
    context: IActionContext,
  ): AsyncIterator<Resource> {
    return new AsyncResourceIterator(
      this.source,
      query,
      context,
      this.mediatorHttp,
    );
  }

  public queryQuads(
    _operation: Operation,
    _context: IActionContext,
  ): AsyncIterator<RDF.Quad> {
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
