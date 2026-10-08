// import.proto FULL DISCREPANCY REPORT: not built yet (WK-14b red).
import type { SqlClient } from '../sync/store.js';

export async function readDiscrepancyReport(_db: SqlClient, _userId: string): Promise<unknown[]> {
  throw new Error('not built');
}
