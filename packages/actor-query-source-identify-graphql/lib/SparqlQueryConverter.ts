import { translate, Algebra } from 'sparqlalgebrajs';
import type { ISparqlJson, IBinding } from 'tree-to-sparqljson';
import { parse } from 'graphql';
import { DocumentNode, ObjectTypeDefinitionNode, Kind } from 'graphql';

const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

export class SparqlQueryConverter {
  public variableMap: Record<string, string>;
  public context: Record<string, string>;
  public typeMap: Record<string, ObjectTypeDefinitionNode> 

  public schema: DocumentNode;

  public constructor(schema_source: string) {
    this.variableMap = {};
    this.context = {};
    this.typeMap = {};

    const schema = parse(schema_source);
    for (const def of schema.definitions) {
      if (def.kind === Kind.OBJECT_TYPE_DEFINITION) {
        this.typeMap[def.name.value] = def;
      }
    }

    for (const [typeName, typeNode] of Object.entries(this.typeMap)) {
      console.log(typeName, " -> ", JSON.stringify(typeNode, null, 2));
    }
  }

  public convertPattern(pattern: Algebra.Pattern) {

  }

  public sparqlToGraphql(sparqlQueryString: string): any {
    const operation = translate(sparqlQueryString);
    return this.operationToGraphql(operation);
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
