import { Algebra } from 'sparqlalgebrajs';
import type * as RDF from '@rdfjs/types';
import type { ComunicaDataFactory } from '@comunica/types';
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

export class SparqlQueryConverter {
  public variableMap: Record<string, string>;

  private dataFactory: ComunicaDataFactory;

  private context: Record<string, string>;
  private entryFields: Field[];

  public constructor(factory: ComunicaDataFactory) {
    this.dataFactory = factory;
  }

  public setSchema(context: Record<string, string>, schema_source: string) {
    this.context = context;

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

  public leaf(): boolean {
    return isScalarType(this.fieldType);
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
      if (this.subField(pred.value).leaf()) {
        varMap[obj.value] = `${this.field.name}_${pred.value}`;
      } else {
        query += "{ id } ";
        varMap[obj.value] = `${this.field.name}_${pred.value}_id`;
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
    if (subj.termType === "Variable") {
      return !this.idArg || !(this.idArg.type instanceof GraphQLNonNull);
    } else if (subj.termType === "NamedNode") {
      return this.idArg !== undefined;
    }
    throw new Error(`Unsupported term type for subject: ${subj.termType}`);
  }

  public withPredObj(pred: RDF.Term, obj: RDF.Term): boolean {
    const field = new Field(this.fieldType.getFields()[pred.value]);

    if (field.leaf()) return obj.termType === "Literal" || obj.termType === "Variable";
    return field.withSubj(obj);
  }

  public subField(pred: string): Field {
    return new Field(this.fieldType.getFields()[pred]);
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