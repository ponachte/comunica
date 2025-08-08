import { translate, Algebra } from 'sparqlalgebrajs';
import type * as RDF from '@rdfjs/types';
import type { ComunicaDataFactory } from '@comunica/types';
import type { ISparqlJson, IBinding } from 'tree-to-sparqljson';
import { 
  buildSchema, 
  getNamedType, 
  GraphQLArgument, 
  GraphQLField, 
  GraphQLID, 
  GraphQLNonNull, 
  GraphQLObjectType,
  isScalarType
 } from 'graphql';

const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

export class SparqlQueryConverter {
  public variableMap: Record<string, string>;

  private context: Record<string, string>;
  private dataFactory: ComunicaDataFactory;

  private entryFields: Field[];

  public constructor(schema_source: string, context: Record<string, string>, factory: ComunicaDataFactory) {
    this.context = context;
    this.dataFactory = factory;

    // Get entryfields
    const schema = buildSchema(schema_source);
    const queryType = schema.getQueryType() ?? (() => { 
      throw new Error('Schema does not define a query type.'); 
    })();
    this.entryFields = Object.values(queryType.getFields()).map(field => new Field(field));
  }

  public convertPattern(pattern: Algebra.Pattern): [string, Record<string, string>][] {
    // convert predicate to graphql namespace
    const s = pattern.subject;
    const p = this.toSchemaNs(pattern.predicate);
    const o = pattern.object;

    // filter triple with fields
    const fields = filterFields(this.entryFields, s, p, o);

    // return field queries
    return fields.map(field => field.toQuery(s, p, o));
  }

  public toSchemaNs(term: RDF.Term): RDF.Term {
    if (term.termType !== "NamedNode") return term;

    for (const [prefix, ns] of Object.entries(this.context)) {
      if (term.value.startsWith(ns)) {
        const local = term.value.slice(ns.length);
        return this.dataFactory.namedNode(`${prefix}_${local}`);
      }
    }

    throw new Error(`Term cannot be converted to schema namespace: ${term.value}`);
  }

  public operationToGraphql(operation: Algebra.Operation): any {
    const patterns = extractPatterns(operation);
    if (patterns) {
      const tree = PatternsToTree(patterns);
      const graphqlQueryString = this.parseRootNode(tree.root);
      return { '@context': this.context, query: graphqlQueryString };
    }
    return null;
  }

  public mapVariables(sparqlResults: ISparqlJson): ISparqlJson {
    return {
      head: {
        vars: sparqlResults.head.vars.map(varName => this.variableMap[varName] || varName),
      },
      results: {
        bindings: sparqlResults.results.bindings.map((binding) => {
          const mappedBinding: IBinding = {};

          for (const key in binding) {
            const mappedKey = this.variableMap[key] || key;
            mappedBinding[mappedKey] = binding[key];
          }

          return mappedBinding;
        }),
      },
    };
  }

  private parseRootNode(node: TreeNode): any {
    let name = '';
    const fields: (string | object)[] = [];

    if (node.children[TYPE]) {
      name = node.id;
      this.context[name] = node.children[TYPE].id;
    } else {
      name = 'Resource';
      // This.context["rdfs"] = RDFS;
    }

    if (node.type === 'Variable') {
      this.variableMap[`${name}_id`] = node.id;
    } else if (node.type === 'NamedNode') {
      // TODO
    } else if (node.type === 'Literal') {
      // TODO
    }

    fields.push('id');

    for (const [ pred, child ] of Object.entries(node.children)) {
      if (pred !== TYPE) {
        fields.push(this.parseNode(pred, child, name));
      }
    }

    return `query { ${name} { ${fields.join(', ')} } }`;
  }

  private parseNode(pred: string, node: TreeNode, varName = ''): string {
    const predName = pred.split(/[#/]/u).pop()!;
    this.context[predName] = pred;
    varName = `${varName}_${predName}`;

    if (node.type === 'Variable') {
      if (Object.keys(node.children).length > 0) {
        // The object is definetely a Resource
        this.variableMap[`${varName}_id`] = node.id;

        const fields = [ 'id', ...Object.entries(node.children).map(([ key, child ]) =>
          this.parseNode(key, child, varName)) ];

        return `${predName} { ${fields.join(', ')} }`;
      }
      // The object is either a Resource or a Literal
      this.variableMap[varName] = node.id;
      delete this.context[predName];
      return `_object(predicate: "${pred}") { _rawRDF }`;
    }
    if (node.type === 'Literal') {
      return `${predName} @filter(if: "${predName} == ${node.id}")`;
    }
    if (node.type === 'NamedNode') {
      return `${predName}(id: "${node.id}") { id }`;
    }

    throw new Error(`Unknown node type: ${node.type} for predicate: ${pred}`);
  }
}

class Field {

  private field: GraphQLField<any, any, any>;
  private fieldType: GraphQLObjectType;
  private idArg: GraphQLArgument | undefined;

  public constructor(field: GraphQLField<any, any, any>) {
    this.field = field;
    this.fieldType = getNamedType(field.type) as GraphQLObjectType;
    this.idArg = field.args.find(arg => getNamedType(arg.type) === GraphQLID);
  }

  public name(): string {
    return this.field.name;
  }

  public toQuery(subj: RDF.Term, pred: RDF.Term, obj: RDF.Term): [string, Record<string, string>] {
    const varMap: Record<string, string> = {};

    // entrypoint
    let query = this.field.name;

    // subject
    if (subj.termType === "NamedNode") {
      query += `(${this.idArg?.name}: "${subj.value}")`
    }

    query += " { ";
    
    if (subj.termType === "Variable") {
      query += "id ";
      varMap[subj.value] = `${this.field.name}_id`;
    }

    // predicate
    query += pred.value + " ";

    // object
    if (obj.termType === "Variable") {
      if (this.hasSubField(pred.value, false)) {
        query += "{ id } ";
        varMap[obj.value] = `${this.field.name}_${pred.value}_id`;
      } else {
        varMap[obj.value] = `${this.field.name}_${pred.value}`;
      }
    } else if (obj.termType === "NamedNode") {
      query += `(id: "${obj.value}") { id } `;
    } else if (obj.termType === "Literal") {
      query += `@filter(if: "${pred.value}==${obj.value}") `
    }

    // end query
    query += "}";

    return [query, varMap];
  }

  public withSubj(subj: RDF.Term): boolean {
    if (subj.termType === "Variable") return !this.mustHaveIdArg();
    if (subj.termType === "NamedNode") return this.canHaveIdArg();
    throw new Error(`Unsupported term type for subject: ${subj.termType}`);
  }

  public withPredObj(pred: RDF.Term, obj: RDF.Term): boolean {
    if (obj.termType === "Variable") {
      return this.hasSubField(pred.value, true) || this.hasSubField(pred.value, false);
    }
    else if (obj.termType === "NamedNode") return this.hasSubField(pred.value, false);
    else if (obj.termType === "Literal") return this.hasSubField(pred.value, true);
    
    throw new Error(`Unsupported term type for object: ${obj.termType}`);
  }

  public canHaveIdArg(): boolean {
    return this.idArg !== undefined;
  }

  public mustHaveIdArg(): boolean {
    if (!this.idArg) return false;
    return this.idArg.type instanceof GraphQLNonNull;
  }

  public hasSubField(pred: string, leaf: boolean): boolean {
    // TODO: check if subfield has ID argument based on obj
    const field = this.fieldType.getFields()[pred];

    if (!field) return false;

    const namedType = getNamedType(field.type);
    return leaf === isScalarType(namedType);
  }
}

function filterFields(fields: Field[], s: RDF.Term, p: RDF.Term, o: RDF.Term): Field[] {

  let filtered = [...fields];

  // eliminate fields based on subject
  filtered = filtered.filter(entrypoint => entrypoint.withSubj(s));

  // eliminate fields based on predicate object combination
  filtered = filtered.filter(entrypoint => entrypoint.withPredObj(p, o));

  return filtered;
}

export interface TreeNode {
  type: string;
  id: string;
  children: Record<string, TreeNode>;
}

export interface Tree {
  root: TreeNode;
  nodes: Record<string, TreeNode>;
}

export function extractPatterns(operation: Algebra.Operation): Algebra.Pattern[] {
  switch (operation.type) {
    case Algebra.types.PROJECT: {
      return extractPatterns(operation.input);
    }
    case Algebra.types.BGP: {
      return (operation).patterns;
    }
    case Algebra.types.PATTERN: {
      return [ (operation) ];
    }
    case Algebra.types.JOIN: {
      // If it's a JOIN, recursively collect patterns from its children
      const join = operation;
      let patterns: Algebra.Pattern[] = [];
      for (const child of join.input) {
        patterns = [ ...patterns, ...extractPatterns(child) ];
      }
      return patterns;
    }
    default: {
      throw new Error(`Unsupported operation type: ${operation.type}`);
    }
  }
}

export function PatternsToTree(patterns: Algebra.Pattern[]): Tree {
  const nodes: Record<string, TreeNode> = {};
  const roots: Record<string, TreeNode> = {};

  for (const pattern of patterns) {
    const subject = pattern.subject;
    const pred = pattern.predicate;
    const object = pattern.object;

    if (!nodes[subject.value]) {
      nodes[subject.value] = { type: subject.termType, id: subject.value, children: {}};
      roots[subject.value] = nodes[subject.value];
    }

    if (object.termType === 'Literal') {
      nodes[subject.value].children[pred.value] = { type: object.termType, id: object.value, children: {}};
    } else {
      if (!nodes[object.value]) {
        nodes[object.value] = { type: object.termType, id: object.value, children: {}};
      }
      nodes[subject.value].children[pred.value] = nodes[object.value];
    }

    if (roots[object.value]) {
      delete roots[object.value];
    }
  }

  return {
    root: Object.values(roots)[0],
    nodes,
  };
}
