import { parseHTML as rawParseHTML } from 'linkedom';

// linkedom's compareDocumentPosition mis-orders nodes in different subtrees (e.g. <p> in the
// first <div> vs <p> in the second reports PRECEDING). Real browsers get this right; install a
// spec-correct version so tests exercise our logic, not the fake DOM's bug.
const FOLLOWING = 4;
const PRECEDING = 2;
const CONTAINS = 8;
const CONTAINED_BY = 16;

function chain(node: any): any[] {
  const nodes: any[] = [];
  for (let current = node; current; current = current.parentNode) nodes.unshift(current);
  return nodes;
}

function compare(this: any, other: any): number {
  if (this === other) return 0;
  const a = chain(this);
  const b = chain(other);
  if (a[0] !== b[0]) return 1 | 32;
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  if (index === a.length) return FOLLOWING | CONTAINED_BY; // other is inside this
  if (index === b.length) return PRECEDING | CONTAINS; // this is inside other
  const siblings = Array.from(a[index - 1].childNodes as ArrayLike<any>);
  return siblings.indexOf(b[index]) > siblings.indexOf(a[index]) ? FOLLOWING : PRECEDING;
}

export function parseHTML(html: string) {
  const result = rawParseHTML(html);
  const proto = Object.getPrototypeOf(Object.getPrototypeOf(result.document.createElement('div')));
  for (let current = proto; current; current = Object.getPrototypeOf(current)) {
    if (Object.prototype.hasOwnProperty.call(current, 'compareDocumentPosition')) {
      current.compareDocumentPosition = compare;
      break;
    }
  }
  return result;
}
