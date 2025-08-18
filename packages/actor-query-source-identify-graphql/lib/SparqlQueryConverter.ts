import type { ComunicaDataFactory } from '@comunica/types';
import type * as RDF from '@rdfjs/types';
import type {
  GraphQLArgument,
  GraphQLField,
  GraphQLObjectType,
} from 'graphql';
import {
  buildSchema,
  getNamedType,
  GraphQLID,
  GraphQLNonNull,
  isScalarType,
} from 'graphql';
import type { Algebra } from 'sparqlalgebrajs';

export class SparqlQueryConverter {
  public variableMap: Record<string, string>;

  private readonly dataFactory: ComunicaDataFactory;

  private readonly context: Record<string, string>;
  private readonly entryFields: Field[];

  public constructor(factory: ComunicaDataFactory, context: Record<string, string>, schema_source: string) {
    this.dataFactory = factory;
    this.context = context;

    // Get entryfields
    const schema = buildSchema(schema_source);
    const queryType = schema.getQueryType() ?? (() => {
      throw new Error('Schema does not define a query type.');
    })();
    this.entryFields = Object.values(queryType.getFields()).map(field => new Field(field));
  }

  public convertOperation(patterns: Algebra.Pattern[]): [string, Record<string, string>][] {
    const trees = this.PatternsToTrees(patterns);

    if (trees.roots.length > 1) {
      throw new Error(`Multiple entrypoints found: ${trees.roots.length}`);
    }
    if (trees.roots.length < 0) {
      throw new Error(`No entrypoints found`);
    }

    const tree = trees.roots[0];
    return filterFields(this.entryFields, tree).map(field => field.toQuery(tree));
  }

  private PatternsToTrees(patterns: Algebra.Pattern[]): Trees {
    const nodes: Record<string, TreeNode> = {};
    const roots: Record<string, TreeNode> = {};

    for (const pattern of patterns) {
      if (pattern.predicate.termType === 'Variable') {
        throw new Error(`Cannot convert queries with a variable predicate.`);
      }

      const subject = pattern.subject;
      const pred = this.toSchemaNs(pattern.predicate).value;
      const object = pattern.object;

      if (!nodes[subject.value]) {
        nodes[subject.value] = { term: subject, children: {}};
        roots[subject.value] = nodes[subject.value];
      }

      if (object.termType === 'Literal') {
        nodes[subject.value].children[pred] = { term: object, children: {}};
      } else {
        if (!nodes[object.value]) {
          nodes[object.value] = { term: object, children: {}};
        }
        nodes[subject.value].children[pred] = nodes[object.value];
      }

      if (roots[object.value]) {
        delete roots[object.value];
      }
    }

    return {
      roots: Object.values(roots),
      nodes,
    };
  }

  public toSchemaNs(term: RDF.Term): RDF.Term {
    if (term.termType !== 'NamedNode') {
      return term;
    }

    for (const [ prefix, ns ] of Object.entries(this.context)) {
      if (term.value.startsWith(ns)) {
        const local = term.value.slice(ns.length);
        return this.dataFactory.namedNode(`${prefix}_${local}`);
      }
    }

    throw new Error(`Term cannot be converted to schema namespace: ${term.value}`);
  }
}

class Field {
  private readonly field: GraphQLField<any, any, any>;
  private readonly fieldType: GraphQLObjectType;
  private readonly idArg: GraphQLArgument | undefined;

  public constructor(field: GraphQLField<any, any, any>) {
    this.field = field;
    this.fieldType = <GraphQLObjectType>getNamedType(field.type);
    this.idArg = field.args.find(arg => getNamedType(arg.type) === GraphQLID);
  }

  public name(): string {
    return this.field.name;
  }

  public leaf(): boolean {
    return isScalarType(this.fieldType);
  }

  public toQuery(node: TreeNode): [string, Record<string, string>] {
    const varMap: Record<string, string> = {};
    let query = this.field.name;

    if (Object.keys(node.children).length > 0) {
      // Not a leaf node
      if (node.term.termType === 'NamedNode') {
        query += `(${this.idArg?.name}: "${node.term.value}")`;
      }

      query += ' { ';

      if (node.term.termType === 'Variable') {
        query += 'id ';
        varMap[node.term.value] = `${this.field.name}_id`;
      }

      // Recursively add children
      for (const [ pred, child ] of Object.entries(node.children)) {
        const field = this.subField(pred);
        const [ childQuery, childVarMap ] = field.toQuery(child);

        query += `${childQuery} `;

        // Update mapped variables
        for (const [ variable, mappedId ] of Object.entries(childVarMap)) {
          varMap[variable] = `${this.field.name}_${mappedId}`;
        }
      }

      query += '} ';
    } else if (node.term.termType === 'Variable') {
      // Leaf node with a variable
      if (this.leaf()) {
        varMap[node.term.value] = `${this.field.name}`;
      } else {
        query += ' { id } ';
        varMap[node.term.value] = `${this.field.name}_id`;
      }
    } else if (node.term.termType === 'Literal') {
      // Leaf node with a literal
      query += ` @filter(if: "${this.field.name}==${node.term.value}") `;
    } else if (node.term.termType === 'NamedNode') {
      // Leaf node with a NamedNode
      query += `(id: "${node.term.value}") { id } `;
    }

    return [ query, varMap ];
  }

  public withId(subj: RDF.Term): boolean {
    if (subj.termType === 'Variable') {
      return !this.idArg || !(this.idArg.type instanceof GraphQLNonNull);
    }
    if (subj.termType === 'NamedNode') {
      return this.idArg !== undefined;
    }
    throw new Error(`Unsupported term type for subject: ${subj.termType}`);
  }

  public withPredNode(pred: string, node: TreeNode): boolean {
    const field = new Field(this.fieldType.getFields()[pred]);

    // Literals are only found on leafs
    if (node.term.termType === 'Literal') {
      return field.leaf();
    }

    // Check if this field accepts the node term
    if (!field.withId(node.term)) {
      return false;
    }

    for (const [ child_pred, child_node ] of Object.entries(node.children)) {
      // Check if this field accepts the children terms
      if (!field.withPredNode(child_pred, child_node)) {
        return false;
      }
    }

    return true;
  }

  public subField(pred: string): Field {
    return new Field(this.fieldType.getFields()[pred]);
  }
}

function filterFields(fields: Field[], node: TreeNode): Field[] {
  let filtered = [ ...fields ];

  if (Object.keys(node.children).length === 0) {
    throw new Error('Not a valid root node: No Children.');
  }

  filtered = filtered.filter(field => field.withId(node.term));

  for (const [ p, child ] of Object.entries(node.children)) {
    filtered = filtered.filter(field => field.withPredNode(p, child));
  }

  return filtered;
}

interface TreeNode {
  term: RDF.Term;
  children: Record<string, TreeNode>;
}

interface Trees {
  roots: TreeNode[];
  nodes: Record<string, TreeNode>;
}
