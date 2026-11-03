const STOPWORDS = new Set(
  'a an and are as at be been but by can do for from has have i if in into is it its me my of on or our should so that the their them then there these this to up us was we were what when which will with would you your please need want make'.split(
    ' ',
  ),
);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    // A rough stem is enough to match fix/fixes/fixing; no dictionary needed.
    out.push(raw.length > 5 ? raw.replace(/(ing|ed|es|s)$/, '') : raw.replace(/s$/, ''));
  }
  return out;
}

/** TF-IDF cosine similarity over an inverted index. */
export class TextIndex {
  private postings = new Map<string, { doc: number; weight: number }[]>();
  private idf = new Map<string, number>();

  constructor(docs: string[]) {
    const counts = docs.map((text) => termCounts(tokenize(text)));
    const df = new Map<string, number>();
    for (const c of counts) for (const term of c.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    for (const [term, n] of df) this.idf.set(term, Math.log(1 + docs.length / n));
    counts.forEach((c, doc) => {
      const vec = this.vector(c);
      for (const [term, weight] of vec) {
        let list = this.postings.get(term);
        if (!list) this.postings.set(term, (list = []));
        list.push({ doc, weight });
      }
    });
  }

  /** Cosine similarity of `text` against every doc that shares a term. */
  scores(text: string): Map<number, number> {
    const out = new Map<number, number>();
    for (const [term, q] of this.vector(termCounts(tokenize(text)))) {
      for (const { doc, weight } of this.postings.get(term) ?? []) {
        out.set(doc, (out.get(doc) ?? 0) + q * weight);
      }
    }
    return out;
  }

  private vector(counts: Map<string, number>): Map<string, number> {
    const vec = new Map<string, number>();
    let norm = 0;
    for (const [term, n] of counts) {
      const w = (1 + Math.log(n)) * (this.idf.get(term) ?? 0);
      if (w > 0) {
        vec.set(term, w);
        norm += w * w;
      }
    }
    norm = Math.sqrt(norm);
    for (const [term, w] of vec) vec.set(term, w / norm);
    return vec;
  }
}

function termCounts(tokens: string[]): Map<string, number> {
  const c = new Map<string, number>();
  for (const t of tokens) c.set(t, (c.get(t) ?? 0) + 1);
  return c;
}
