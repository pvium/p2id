import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InFlightJobs } from '../src/inflight.js';

const url = (s = 'https://api.example.com/proofs/callback?secret=abc') => new URL(s);
const req = { identityType: 'email', identityValue: 'User@Example.com', wallet: '0xA01b6E60D51eDB3fEB9f86a62b846f4F90070f98' };

test('the key identifies the proof and its receiver, not the token or letter case', () => {
  const k = InFlightJobs.key(req, url());
  assert.equal(InFlightJobs.key({ ...req, identityValue: 'user@example.com', wallet: req.wallet.toLowerCase() }, url()), k);
  assert.equal(InFlightJobs.key({ ...req, jwt: 'a-newer-token' } as typeof req, url()), k);
  assert.notEqual(InFlightJobs.key({ ...req, identityValue: 'other@example.com' }, url()), k);
  assert.notEqual(InFlightJobs.key({ ...req, identityType: 'google_oauth' }, url()), k);
  assert.notEqual(InFlightJobs.key({ ...req, wallet: '0x899BA183F2c55BF9C627D9Af2984fbdED2E64311' }, url()), k);
  assert.notEqual(InFlightJobs.key({ ...req, wallet: undefined }, url()), k);
  // a different receiver must get its own job, or it would never be called back
  assert.notEqual(InFlightJobs.key(req, url('https://other.example.com/hook')), k);
});

test('case-sensitive values stay distinct, and fields cannot be shifted into each other', () => {
  const sol = { identityType: 'wallet', identityValue: 'EXnVUEeELHiYynvjoQ9YhgxfMSDJC6tJm7VkFQY2b8Wj' };
  assert.notEqual(InFlightJobs.key(sol, url()), InFlightJobs.key({ ...sol, identityValue: sol.identityValue.toLowerCase() }, url()));
  assert.notEqual(InFlightJobs.key({ identityType: 'phone', identityValue: '+1555', wallet: 'ab' }, url()), InFlightJobs.key({ identityType: 'phone', identityValue: '+1555a', wallet: 'b' }, url()));
});

test('a job is findable while in flight and its key is free again afterwards', () => {
  const jobs = new InFlightJobs();
  const k = InFlightJobs.key(req, url());
  assert.equal(jobs.find(k), undefined);
  jobs.add(k, 'job-1');
  assert.equal(jobs.find(k), 'job-1');
  assert.ok(jobs.get('job-1'));
  assert.equal(jobs.size, 1);
  jobs.remove('job-1');
  assert.equal(jobs.find(k), undefined);
  assert.equal(jobs.get('job-1'), undefined);
  jobs.remove('job-1'); // idempotent
  assert.equal(jobs.size, 0);
});
