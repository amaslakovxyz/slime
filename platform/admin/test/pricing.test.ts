// Tier pricing and crystallization savings: pure arithmetic, no DynamoDB.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { allGasBill, crystallizationSavings, estimateBill, tierCost } from '../lib/pricing';

const traffic = (gasRequests: number, liquidRequests: number, crystalRequests: number, generations: number) => ({
  gasRequests,
  liquidRequests,
  crystalRequests,
  generations,
});

describe('pricing', () => {
  test('each request is priced by its tier, plus a flat price per generation', () => {
    // Gas $2.00/1k, Liquid $0.50/1k, Crystal $0.10/1k, $0.02 per generation.
    assert.equal(estimateBill(traffic(1000, 0, 0, 0)), 2);
    assert.equal(estimateBill(traffic(0, 1000, 0, 0)), 0.5);
    assert.equal(estimateBill(traffic(0, 0, 1000, 0)), 0.1);
    assert.equal(estimateBill(traffic(0, 0, 0, 50)), 1);
    assert.equal(estimateBill(traffic(150, 800, 2000, 15)), 1.2);
  });

  test('estimates round to cents', () => {
    assert.equal(estimateBill(traffic(1, 1, 1, 0)), 0);
    assert.equal(estimateBill(traffic(3, 0, 0, 0)), 0.01);
    assert.equal(tierCost('crystal', 12345), 1.23);
  });

  test('savings compare against the same traffic served entirely as Gas', () => {
    assert.equal(allGasBill(traffic(150, 800, 2000, 15)), 6.2);
    assert.equal(crystallizationSavings(traffic(150, 800, 2000, 15)), 5);
    // Nothing crystallized, nothing saved; generations cost the same either way.
    assert.equal(crystallizationSavings(traffic(5000, 0, 0, 40)), 0);
    assert.equal(crystallizationSavings(traffic(0, 0, 0, 0)), 0);
  });
});
