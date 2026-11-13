import { describe, expect, it } from 'vitest';
import {
  type BoardSiteSource,
  boardSiteOf,
  boardSiteQuery,
  domainSuffixes,
  proveBoardSite,
  senderDomainOf,
} from './official-board';

function answer(rows: Array<[qid: string, site: string]>) {
  return {
    results: {
      bindings: rows.map(([qid, site]) => ({
        item: { value: `http://www.wikidata.org/entity/${qid}` },
        site: { value: site },
      })),
    },
  };
}

describe('senderDomainOf', () => {
  it('reads the domain of a display-name address and of a bare one', () => {
    expect(senderDomainOf('Office <Office@Mail.Board.Example>')).toBe('mail.board.example');
    expect(senderDomainOf('office@board.example')).toBe('board.example');
  });

  it('is null for no address or something that is not a host', () => {
    expect(senderDomainOf('Board Office')).toBeNull();
    expect(senderDomainOf('x@localhost')).toBeNull();
    expect(senderDomainOf('x@board example')).toBeNull();
  });
});

describe('domainSuffixes', () => {
  it('walks up to two labels and never asks about a bare suffix', () => {
    expect(domainSuffixes('a.b.board.example')).toEqual([
      'a.b.board.example',
      'b.board.example',
      'board.example',
    ]);
    expect(domainSuffixes('example')).toEqual([]);
  });
});

describe('boardSiteQuery', () => {
  it('asks only for root sites of plain hosts', () => {
    const query = boardSiteQuery(['board.example', 'x> } DROP {']);
    expect(query).toContain('<https://www.board.example/>');
    expect(query).toContain('<http://board.example>');
    expect(query).not.toContain('DROP');
  });

  // Live Wikidata (2026-11-13): every Ontario board probed is a school district or a board
  // of education, the private K-12 schools are secondary schools, and the universities,
  // colleges and the conservatory are higher education institutions. "Educational
  // institution" holds all of them, so it proves nothing about a kid's own school.
  it('proves a school board, a school district or a K-12 school, never higher education', () => {
    const query = boardSiteQuery(['board.example']);
    expect(query).not.toContain('wd:Q2385804');
    for (const k12 of ['wd:Q398141', 'wd:Q399541', 'wd:Q9842', 'wd:Q159334']) {
      expect(query).toContain(k12);
    }
    expect(query).toMatch(/FILTER NOT EXISTS \{ \?item wdt:P31\/wdt:P279\* wd:Q38723 \}/);
  });
});

describe('boardSiteOf', () => {
  it('proves the host of the institution whose site is the sender domain or a parent of it', () => {
    expect(
      boardSiteOf('mail.board.example', answer([['Q7', 'https://www.board.example/']])),
    ).toEqual({ status: 'found', host: 'board.example', source: 'wikidata:Q7' });
  });

  it('prefers the widest proven host, so the board holds its schools', () => {
    const found = boardSiteOf(
      'school.board.example',
      answer([
        ['Q9', 'https://school.board.example/'],
        ['Q7', 'https://www.board.example/'],
      ]),
    );
    expect(found).toEqual({ status: 'found', host: 'board.example', source: 'wikidata:Q7' });
  });

  it('proves nothing when the source holds no institution for the domain', () => {
    expect(boardSiteOf('gmail.example', answer([]))).toEqual({ status: 'not_found' });
  });

  it('ignores a row whose site is not one of the sender domain suffixes', () => {
    expect(boardSiteOf('board.example', answer([['Q8', 'https://other.example/']]))).toEqual({
      status: 'not_found',
    });
  });
});

describe('proveBoardSite', () => {
  it('is a retry, not a verdict, when the source fails or answers garbage', async () => {
    const down: BoardSiteSource = {
      sparql: async () => {
        throw new Error('timeout');
      },
    };
    const garbage: BoardSiteSource = { sparql: async () => ({ nope: true }) };
    expect(await proveBoardSite(down, 'board.example')).toEqual({
      status: 'retry',
      reason: 'source_failed:Error',
    });
    expect(await proveBoardSite(garbage, 'board.example')).toEqual({
      status: 'retry',
      reason: 'source_unparsed',
    });
  });
});
