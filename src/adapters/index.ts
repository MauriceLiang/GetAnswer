import type { CodeFiller, CodeReader, SiteAdapter } from './base';
import { AlphaCodingAdapter } from './alphacoding';

export function findAdapter(
  document: globalThis.Document,
  location: globalThis.Location,
  fillCode?: CodeFiller,
  readCode?: CodeReader
): SiteAdapter | null {
  const adapters: SiteAdapter[] = [
    new AlphaCodingAdapter(document, location, fillCode, undefined, readCode)
  ];
  return adapters.find((adapter) => adapter.match()) ?? null;
}
