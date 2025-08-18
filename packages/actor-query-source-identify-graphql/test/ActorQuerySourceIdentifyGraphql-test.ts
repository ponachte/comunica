import { ActorQuerySourceIdentify } from '@comunica/bus-query-source-identify';
import { Bus } from '@comunica/core';
import { ActorQuerySourceIdentifyGraphql } from '../lib/ActorQuerySourceIdentifyGraphql';

describe('ActorQuerySourceIdentifyGraphql', () => {
  let bus: any;
  // Let mediatorHttp: any;

  beforeEach(() => {
    bus = new Bus({ name: 'bus' });
    // MediatorHttp = new MediatorRace({ name: 'mediator-http', bus: new Bus({ name: 'bus-http' }) });
    // jest.clearAllMocks();
  });

  describe('The ActorQuerySourceIdentifyGraphql module', () => {
    it('should be a function', () => {
      expect(ActorQuerySourceIdentifyGraphql).toBeInstanceOf(Function);
    });

    it('should be a ActorQuerySourceIdentifyHypermedia constructor', () => {
      expect(new (<any> ActorQuerySourceIdentifyGraphql)({ name: 'actor', bus }))
        .toBeInstanceOf(ActorQuerySourceIdentifyGraphql);
      expect(new (<any> ActorQuerySourceIdentifyGraphql)({ name: 'actor', bus }))
        .toBeInstanceOf(ActorQuerySourceIdentify);
    });
  });
});
