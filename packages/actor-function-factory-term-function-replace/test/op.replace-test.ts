import { runFuncTestTable } from '@comunica/bus-function-factory/test/util';
import { Notation } from '@comunica/expression-evaluator/test/util/TestTable';
import { ActorFunctionFactoryTermFunctionReplace } from '../lib';

describe('evaluation of \'replace\' like', () => {
  runFuncTestTable({
    registeredActors: [
      args => new ActorFunctionFactoryTermFunctionReplace(args),
    ],
    arity: 'vary',
    operation: 'replace',
    notation: Notation.Function,
    testTable: `
      "baaab" "a+" "c" = "bcb"
      "bAAAb" "a+" "c" = "bAAAb"
      "bAAAb" "a+" "c" "i" = "bcb"
      "baaab"@en "a+" "c" = "bcb"@en
      "bAAAb"@en "a+" "c" "i" = "bcb"@en
      `,
  });
});
