// The @slime-cloud/core/testing entry: contract suites for custom adapters (C13), and test doubles.
export { describeStoreContract, type StoreFactory } from './store-contract.js';
export {
  artifact,
  fakeConnector,
  fakeGenerator,
  fakeReviewer,
  stubGenerator,
  stubReviewer,
  type ConnectorScript,
  type ScriptedConnector,
  type StubGenerator,
  type StubReviewer,
  type Verdict,
} from './fakes.js';
