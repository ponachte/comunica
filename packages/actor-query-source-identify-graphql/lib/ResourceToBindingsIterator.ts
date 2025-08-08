import type { AsyncIterator } from 'asynciterator';
import { TransformIterator } from 'asynciterator';
import type * as RDF from '@rdfjs/types';
import type { Algebra } from 'sparqlalgebrajs';
import type { Resource } from './AsyncResourceIterator';
import { ComunicaDataFactory } from '@comunica/types';
import type { BindingsFactory } from '@comunica/utils-bindings-factory';

export class ResourceToBindingsIterator extends TransformIterator<Resource, RDF.Bindings> {
  private readonly pattern: Algebra.Pattern;
  private readonly varMap: Record<string, string>;
  private readonly dataFactory: ComunicaDataFactory;
  private readonly bindingsFactory: BindingsFactory;

  public constructor(
    source: AsyncIterator<Resource>,
    pattern: Algebra.Pattern,
    varMap: Record<string, string>,
    dataFactory: ComunicaDataFactory,
    bindingsFactory: BindingsFactory,
  ) {
    super(source, { autoStart: false });
    this.pattern = pattern;
    this.varMap = varMap;
    this.dataFactory = dataFactory;
    this.bindingsFactory = bindingsFactory;
  }

  protected override _transform(
    resource: Resource,
    done: () => void,
    push: (binding: RDF.Bindings) => void,
  ): void {
    const s = this.pattern.subject;
    const o = this.pattern.object;

    const binding: Record<string, RDF.Term> = {};
    if (s.termType === 'Variable') {
      binding[s.value] = this.dataFactory.namedNode(resource[this.varMap[s.value]]);
    }

    if (o.termType === 'Variable') {
      // WARNING: value term type is assumed
      const value = resource[this.varMap[o.value]];
      if (/^https?:\/\/.+/.test(value)) {
        binding[o.value] = this.dataFactory.namedNode(value);
      } else {
        binding[o.value] = this.dataFactory.literal(value);
      }
    }

    push(this.convertToBindings(binding));

    done();
  }

  private convertToBindings(raw: Record<string, RDF.Term>): RDF.Bindings {
    return this.bindingsFactory.bindings(
      Object.entries(raw).map(([key, term]) => [this.dataFactory.variable(key), term])
    );
  }
}

export class RawResourceToBindingsIterator extends TransformIterator<Resource, RDF.Bindings> {
  private readonly pattern: Algebra.Pattern;
  private readonly dataFactory: ComunicaDataFactory;
  private readonly bindingsFactory: BindingsFactory;

  public constructor(
    source: AsyncIterator<Resource>,
    pattern: Algebra.Pattern,
    dataFactory: ComunicaDataFactory,
    bindingsFactory: BindingsFactory,
  ) {
    super(source, { autoStart: false });
    this.pattern = pattern;
    this.dataFactory = dataFactory;
    this.bindingsFactory = bindingsFactory;
  }

  protected override _transform(
    resource: Resource,
    done: () => void,
    push: (binding: RDF.Bindings) => void,
  ): void {
    const { subject, predicate, object } = this.pattern;

    const base: Record<string, RDF.Term> = {};
    if (subject.termType === 'Variable') {
      base[subject.value] = this.dataFactory.namedNode(resource.id);
    }

    if (resource._relations) {
      for (const rel of resource._relations) {
        const binding: Record<string, RDF.Term> = { ...base };
        if (predicate.termType === 'Variable') {
          binding[predicate.value] = this.dataFactory.namedNode(rel);
        }
        push(this.convertToBindings(binding));
      }
    } else {
      for (const pred of Object.keys(resource)) {
        if (pred === 'id') continue;
        for (const obj of resource[pred]) {
          const binding: Record<string, RDF.Term> = { ...base };

          if (predicate.termType === 'Variable') {
            binding[predicate.value] = this.dataFactory.namedNode(pred);
          }

          if (object.termType === 'Variable') {
            const raw = obj._rawRDF;
            if (raw['@id']) {
              binding[object.value] = this.dataFactory.namedNode(raw['@id']);
            } else {
              binding[object.value] = this.dataFactory.literal(
                raw['@value'],
                raw['@type'] ? this.dataFactory.namedNode(raw['@type']) : undefined
              );
            }
          }

          push(this.convertToBindings(binding));
        }
      }
    }

    done();
  }

  private convertToBindings(raw: Record<string, RDF.Term>): RDF.Bindings {
    return this.bindingsFactory.bindings(
      Object.entries(raw).map(([key, term]) => [this.dataFactory.variable(key), term])
    );
  }
}