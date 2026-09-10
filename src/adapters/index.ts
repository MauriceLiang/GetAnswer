import type { CodeFiller, SiteAdapter } from './base';
import { AlphaCodingAdapter } from './alphacoding';

export function findAdapter(
  document: globalThis.Document,
  location: globalThis.Location,
  fillCode?: CodeFiller
): SiteAdapter | null {
  const adapters: SiteAdapter[] = [new AlphaCodingAdapter(document, location, fillCode)];
  return adapters.find((adapter) => adapter.match()) ?? null;
}
