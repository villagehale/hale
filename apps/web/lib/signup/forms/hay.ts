import type { PageControl } from '../types';

export function controlHay(control: PageControl): string {
  return `${control.name} ${control.label} ${control.autocomplete ?? ''} ${control.type}`
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
}
