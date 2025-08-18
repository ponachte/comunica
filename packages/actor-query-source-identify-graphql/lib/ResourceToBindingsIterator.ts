import type { ComunicaDataFactory } from '@comunica/types';
import type { BindingsFactory } from '@comunica/utils-bindings-factory';
import type * as RDF from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import { TransformIterator } from 'asynciterator';
import type { Resource } from './AsyncResourceIterator';

export class ResourceToBindingsIterator extends TransformIterator<Resource, RDF.Bindings> {
  private readonly variables: RDF.Variable[];
  private readonly varMap: Record<string, string>;
  private readonly dataFactory: ComunicaDataFactory;
  private readonly bindingsFactory: BindingsFactory;

  public constructor(
    source: AsyncIterator<Resource>,
    variables: RDF.Variable[],
    varMap: Record<string, string>,
    dataFactory: ComunicaDataFactory,
    bindingsFactory: BindingsFactory,
  ) {
    super(source, { autoStart: false });
    this.variables = variables;
    this.varMap = varMap;
    this.dataFactory = dataFactory;
    this.bindingsFactory = bindingsFactory;
  }

  protected override _transform(
    resource: Resource,
    done: () => void,
    push: (binding: RDF.Bindings) => void,
  ): void {
    const binding: Record<string, RDF.Term> = {};
    for (const variable of this.variables) {
      // WARNING: value term type is assumed
      const varName = variable.value;
      const value = resource[this.varMap[varName]];
      if (/^https?:\/\/.+/u.test(value)) {
        binding[varName] = this.dataFactory.namedNode(value);
      } else {
        binding[varName] = this.dataFactory.literal(value);
      }
    }

    push(this.convertToBindings(binding));

    done();
  }

  private convertToBindings(raw: Record<string, RDF.Term>): RDF.Bindings {
    return this.bindingsFactory.bindings(
      Object.entries(raw).map(([ key, term ]) => [ this.dataFactory.variable(key), term ]),
    );
  }
}
