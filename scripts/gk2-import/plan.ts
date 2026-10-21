// The import plan: what to hold, decided by the people who read the list, as strict JSON. The tool reads it and
// decides nothing; a plan that is not exactly this shape is refused before a single facet is built.
import { DISPOSAL_REASONS, type DisposalReason } from '@figurecollecting/fc-api-contract';

export type Kind = 'matched' | 'text' | 'parked';
export type Status = 'owned' | 'ordered' | 'former';

export interface Label {
  name: string;
  maker?: string;
  series?: string;
  scale?: string;
  edition?: string;
}

export interface Disposal {
  reason: DisposalReason;
  note?: string;
  counterparty?: string;
}

export interface Entry {
  /** One line of the list, e.g. owned-3: names the entry in every message and seeds its ids. */
  line: string;
  /** matched: a spine product; text: no product, a label; parked: a set, written by nothing here. */
  kind: Kind;
  status: Status;
  /** matched: the spine product; parked: a hint for whoever unparks it. Never on a text entry. */
  headId?: string;
  copies: number;
  label?: Label;
  note?: string;
  links: string[];
  /** The name of a collection to file each copy in (owned and ordered only). */
  collection?: string;
  /** Former only. Omitted when the reason is not known. */
  disposal?: Disposal;
  tags: string[];
}

export interface Plan {
  namespace: string;
  entries: Entry[];
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS: readonly Kind[] = ['matched', 'text', 'parked'];
const STATUSES: readonly Status[] = ['owned', 'ordered', 'former'];
const MAX_LINKS = 10;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Throw unless `value` is an object with only `allowed` keys. */
function closed(where: string, value: unknown, allowed: readonly string[]): Json {
  if (!isObject(value)) throw new PlanError(`${where} is not an object`);
  for (const key of Object.keys(value)) if (value[key] !== undefined && !allowed.includes(key)) throw new PlanError(`${where} has an unknown key: ${key}`);
  return value;
}

function text(where: string, value: unknown, required = false): string | undefined {
  if (value === undefined) {
    if (required) throw new PlanError(`${where} is missing`);
    return undefined;
  }
  if (typeof value !== 'string' || value === '') throw new PlanError(`${where} is not a non-empty string`);
  return value;
}

function label(where: string, value: unknown): Label {
  const l = closed(where, value, ['name', 'maker', 'series', 'scale', 'edition']);
  const out: Label = { name: text(`${where}.name`, l['name'], true)! };
  for (const key of ['maker', 'series', 'scale', 'edition'] as const) {
    const v = text(`${where}.${key}`, l[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function disposal(where: string, value: unknown): Disposal {
  const d = closed(where, value, ['reason', 'note', 'counterparty']);
  if (!(DISPOSAL_REASONS as readonly unknown[]).includes(d['reason'])) throw new PlanError(`${where}.reason is not one of ${DISPOSAL_REASONS.join(', ')}`);
  const out: Disposal = { reason: d['reason'] as DisposalReason };
  const note = text(`${where}.note`, d['note']);
  const counterparty = text(`${where}.counterparty`, d['counterparty']);
  if (note !== undefined) out.note = note;
  if (counterparty !== undefined) out.counterparty = counterparty;
  return out;
}

function entry(index: number, value: unknown): Entry {
  const raw = closed(`entries[${index}]`, value, ['line', 'kind', 'status', 'headId', 'copies', 'label', 'note', 'links', 'collection', 'disposal', 'tags']);
  const line = raw['line'];
  if (typeof line !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(line)) throw new PlanError(`entries[${index}].line is not a name of letters, digits and . _ -`);
  const at = `entry ${line}`;
  const kind = raw['kind'];
  const status = raw['status'];
  if (!(KINDS as readonly unknown[]).includes(kind)) throw new PlanError(`${at}: kind is not one of ${KINDS.join(', ')}`);
  if (!(STATUSES as readonly unknown[]).includes(status)) throw new PlanError(`${at}: status is not one of ${STATUSES.join(', ')}`);
  const copies = raw['copies'];
  if (typeof copies !== 'number' || !Number.isInteger(copies) || copies < 1 || copies > 99) throw new PlanError(`${at}: copies is not a whole number from 1 to 99`);
  const out: Entry = { line, kind: kind as Kind, status: status as Status, copies, links: [], tags: [] };

  const headId = raw['headId'];
  if (out.kind === 'text') {
    if (headId !== undefined) throw new PlanError(`${at}: a text entry has no head (one is minted from its line)`);
    if (raw['label'] === undefined) throw new PlanError(`${at}: a text entry needs a label`);
    out.label = label(`${at}: label`, raw['label']);
  } else {
    if (typeof headId !== 'string' || !UUID.test(headId)) throw new PlanError(`${at}: headId is not a lowercase dashed uuid`);
    out.headId = headId;
    if (raw['label'] !== undefined) throw new PlanError(`${at}: only a text entry carries a label`);
  }

  const note = raw['note'];
  if (note !== undefined) {
    if (typeof note !== 'string') throw new PlanError(`${at}: note is not text`);
    out.note = note;
  }
  const links = raw['links'];
  if (!Array.isArray(links)) throw new PlanError(`${at}: links is not a list`);
  if (links.length > MAX_LINKS) throw new PlanError(`${at}: more than ${MAX_LINKS} links`);
  out.links = links.map((l, i) => text(`${at}: links[${i}]`, l, true)!);

  const collection = raw['collection'];
  if (collection !== undefined) {
    if (out.status === 'former') throw new PlanError(`${at}: a former copy is filed in no collection`);
    out.collection = text(`${at}: collection`, collection, true)!;
  }
  if (raw['disposal'] !== undefined) {
    if (out.status !== 'former') throw new PlanError(`${at}: only a former copy has a disposal`);
    out.disposal = disposal(`${at}: disposal`, raw['disposal']);
  }
  const tags = raw['tags'];
  if (!Array.isArray(tags)) throw new PlanError(`${at}: tags is not a list`);
  out.tags = tags.map((t, i) => text(`${at}: tags[${i}]`, t, true)!);
  return out;
}

export function parsePlan(value: unknown): Plan {
  const plan = closed('plan', value, ['namespace', 'entries']);
  const namespace = plan['namespace'];
  if (typeof namespace !== 'string' || !UUID.test(namespace)) throw new PlanError('plan.namespace is not a lowercase dashed uuid');
  if (!Array.isArray(plan['entries'])) throw new PlanError('plan.entries is not a list');
  const entries = plan['entries'].map((e, i) => entry(i, e));
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.line)) throw new PlanError(`line ${e.line} appears twice`);
    seen.add(e.line);
  }
  return { namespace, entries };
}
