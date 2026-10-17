import { describe, it } from 'vitest';

describe('optional LocalStack integration', () => {
  it.skipIf(process.env.LOCALSTACK !== '1')('runs only when LOCALSTACK=1', () => {
    // The AWS integration harness is intentionally opt-in for local development.
  });
});
