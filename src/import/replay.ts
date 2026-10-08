// import.proto LATE EDITS AND REPLAY, the pure half: not built yet (the red run).
import type { Facet } from '../sync/store.js';
import type { CopyBase, OccIdOf, Value } from './figure.js';
import type { FigureItem, ImportState, KeptCopy, Plan, Row } from './plan.js';
import type { Field } from './rows.js';

export interface FrameBefore {
  rows: Row[];
  rowBases: Row[];
  copyBases: [string, CopyBase][];
  fieldBases: [Field, Value | null][];
  item: FigureItem | null;
  kept: [string, KeptCopy][];
  occs: string[];
}
export interface Frame {
  importNumber: number;
  exportDate: string;
  before: FrameBefore;
}
export interface Summary {
  copies: Record<string, string>;
  items: { figure: string | null; change: string | null };
}
export interface Revision {
  head: string;
  marker: bigint;
  seq: bigint;
  before: Summary;
  after: Summary;
}
const notBuilt = (): never => {
  throw new Error('not built');
};
export const frameBefores = (_st: ImportState, _figures: readonly string[], _rows: readonly Row[]): Map<string, FrameBefore> => notBuilt();
export const placeEdits = (_base: ReadonlyMap<string, Facet>, _edits: readonly Facet[]): Map<string, Facet> => notBuilt();
export const keptEndedBy = (_kept: ReadonlyMap<string, KeptCopy>, _edits: readonly Facet[]): string[] => notBuilt();
export const decideAgain = (_f: Frame, _S: string, _pre: ReadonlyMap<string, Facet>, _late: readonly Facet[], _occId: OccIdOf): Plan => notBuilt();
export const sameDecision = (_a: Plan, _b: Plan): boolean => notBuilt();
export const summarize = (_S: string, _facets: ReadonlyMap<string, Facet>, _occs: Iterable<string>): Summary => notBuilt();
export const reacts = (_r: Revision, _key: string, _onFigure: boolean, _hadHead: boolean, _saw: string | null): boolean => notBuilt();
export const figureKeys = (_S: string, _occs: Iterable<string>): string[] => notBuilt();
export const isServerVersion = (_v: string): boolean => notBuilt();
