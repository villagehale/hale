import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHROME, PLATES, displaySmsNumber, plateFor, smsHref } from './plates.mjs';

const PRINT_HTML = join(dirname(fileURLToPath(import.meta.url)), 'print/earlyon-ossington.html');

describe('neighborhood poster plates', () => {
  it('registers Ossington as an earlyon-* plate with its own QR body', () => {
    const plate = plateFor('earlyon-ossington');
    assert.equal(plate.sourceCode, 'earlyon-ossington');
    assert.equal(plate.neighborhood, 'FOR OSSINGTON FAMILIES');
    assert.match(plate.sourceCode, /^earlyon-/);
    assert.doesNotMatch(plate.sourceCode, /^poster-/);
  });

  it('builds a prefilled sms: URI, not a marketing-site URL', () => {
    const href = smsHref('earlyon-ossington');
    assert.equal(href, 'sms:+12892172279?&body=Hi%20(via%20earlyon-ossington)');
    assert.doesNotMatch(href, /^https?:/);
    assert.doesNotMatch(href, /villagehale\.com/);
  });

  it('prints the pack number in the same grouping as the footer button', () => {
    assert.equal(displaySmsNumber('+12892172279'), '+1 (289) 217-2279');
  });

  it('keeps the pack chrome lines on every plate', () => {
    assert.equal(CHROME.headline, 'The family assistant you text.');
    assert.equal(CHROME.pronunciation, '/HAH-LEH/ · HAWAIIAN FOR HOME');
    assert.match(CHROME.cta, /Free to start/);
    assert.equal(Object.keys(PLATES).length > 0, true);
  });

  it('print plate is Ossington, with its own sms QR — not a marketing URL', () => {
    const html = readFileSync(PRINT_HTML, 'utf8');
    assert.match(html, /FOR OSSINGTON FAMILIES/);
    assert.match(html, /data-sms="sms:\+12892172279\?&amp;body=Hi%20\(via%20earlyon-ossington\)"/);
    assert.doesNotMatch(html, /FOR NORTH YORK FAMILIES/);
    assert.doesNotMatch(html, /villagehale\.com/);
  });
});
