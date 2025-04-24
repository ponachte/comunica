import { Bus } from '@comunica/core';
import { MediatorRace } from '@comunica/mediator-race';
import { ActorQuerySourceIdentifyGraphql } from '../lib/ActorQuerySourceIdentifyGraphql';

describe('ActorQuerySourceIdentifyGraphql', () => {
  let bus: any;
  let mediatorHttp: any;

  beforeEach(() => {
    bus = new Bus({ name: 'bus' });
    mediatorHttp = new MediatorRace({ name: 'mediator-http', bus: new Bus({ name: 'bus-http' }) });
    jest.clearAllMocks();
  });

  describe('The ActorQuerySourceIdentifyGraphql module', () => {
    it('should be a function', () => {
      expect(ActorQuerySourceIdentifyGraphql).toBeInstanceOf(Function);
    });

    it('should be a ActorQuerySourceIdentifyHypermedia constructor', () => {
      expect(new (<any> ActorQuerySourceIdentifyGraphql)({
        bus,
        mediatorHttp,
      })).toBeInstanceOf(ActorQuerySourceIdentifyGraphql);
    });
  });
});
