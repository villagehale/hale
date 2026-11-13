// Deterministic gates and the --dry worst case for evals/group-reminder-eval.mjs (VIL-448 ·
// T26). Pure: no model, no network and no web TypeScript, so it is unit-tested on its own
// (group-reminder-gates.test.mjs). The runner passes in the runtime's own functions
// (askedInstant, sameFirstName, inQuiet, worstCaseUsd) rather than copies of them.
//
// Nothing here reads a word of a text. The gates check the structured reading, the plan the
// runtime derives from it, and whether two texts with different facts came out identical
// (fixed copy). Whether a text says the right thing is the judge's call.

export const JUDGE_REASON_MAX_CHARS = 300;

/** Attempts the runtime reader makes before it gives up (read.ts). */
export const READ_ATTEMPTS = 2;

/**
 * Sends one forceToolJson call can make: the first, one re-ask when it came back empty, on
 * an adaptive lane one more with thinking off, and one more when the answer is garbled
 * (packages/agent structured.ts).
 */
export function maxSends(lane) {
  return lane.thinking === 'adaptive' ? 4 : 3;
}

/**
 * Input tokens of a request, estimated offline: one per three UTF-8 bytes of its JSON, the
 * estimate the harness's --dry uses. The live spend guard counts them for real.
 */
export function offlineInputTokens(request) {
  const { system, messages, tools, output_config } = request;
  const bytes = Buffer.byteLength(JSON.stringify({ system, messages, tools, output_config }));
  return Math.ceil(bytes / 3);
}

/**
 * One planned call. `perSend` is the spend guard's worst case for a single send (counted
 * input at the cache-write rate, the full max_tokens of output). `ceiling` is every attempt
 * the runtime makes and every re-ask inside each of them firing at that price.
 */
export function priceCall({ request, lane, attempts, rates, worstCaseUsd }) {
  const perSend = worstCaseUsd(rates, request, offlineInputTokens(request));
  return { perSend, ceiling: perSend * maxSends(lane) * attempts };
}

function primaryTag(tag) {
  return typeof tag === 'string' ? (tag.trim().toLowerCase().split('-')[0] ?? '') : '';
}

/**
 * How a text says "you" to the people reading it, as the judge reads it from the text. A
 * fact the judge reports, not a score: code compares it with `facts.audience`.
 */
export const ADDRESS_FORMS = ['none', 'one_form', 'plural_or_formal', 'familiar_singular'];

/**
 * Languages whose register result is reported but does not fail the run (VIL-493). The
 * judge's read of French address was unstable (the same familiar-singular group confirm
 * scored 2, 5, 2, 4); it blocks again once it holds across re-records.
 */
export const SOFT_REGISTER_LANGUAGES = new Set(['fr']);

const ADDRESS_WORDS = {
  plural_or_formal: 'the plural or formal',
  familiar_singular: 'the familiar singular',
};

/**
 * Who is reading against how the text addresses them. `group`: the whole chat reads it, so
 * any "you" is the plural or formal one, even when one person is named. `direct`: one
 * person, the familiar singular. No "you" at all always fits. Null when it fits.
 */
export function registerFinding({ audience, language, address }) {
  const soft = SOFT_REGISTER_LANGUAGES.has(primaryTag(language));
  if (!ADDRESS_FORMS.includes(address)) {
    return { finding: 'register: the judge did not say how the text addresses its readers', soft };
  }
  const misfit = audience === 'group' ? 'familiar_singular' : 'plural_or_formal';
  if (address !== misfit) return null;
  return { finding: `register: ${audience} text addressed in ${ADDRESS_WORDS[address]}`, soft };
}

const iso = (at) => (at ? at.toISOString() : 'none');

/**
 * The reading's structured fields against what the case means. A time is compared as the
 * instant it resolves to, so "today at 5:30" and a bare "5:30" are the same answer. `what`
 * is not checked here: whether a text is about the right thing is the judge's call.
 */
export function readingFailures(expect, reading, { instantOf, sameName }) {
  if (!reading) return ['unread: no usable reading after every attempt'];
  if (reading.request !== expect.request) {
    return [`request read as ${reading.request}, want ${expect.request}`];
  }
  if (expect.request !== 'reminders') return [];
  const failures = [];
  const want = expect.set ?? [];
  if (reading.set.length !== want.length) {
    failures.push(`${reading.set.length} reminders read, want ${want.length}`);
  }
  want.forEach((ask, i) => {
    const got = reading.set[i];
    if (!got) return;
    if (got.for !== ask.for) failures.push(`reminder ${i + 1} is for ${got.for}, want ${ask.for}`);
    if (ask.for === 'person' && !(typeof got.name === 'string' && sameName(got.name, ask.name))) {
      failures.push(`reminder ${i + 1} names ${got.name}, want ${ask.name}`);
    }
    const gotAt = instantOf(got);
    const wantAt = instantOf(ask);
    if ((gotAt?.getTime() ?? null) !== (wantAt?.getTime() ?? null)) {
      failures.push(`reminder ${i + 1} resolves to ${iso(gotAt)}, want ${iso(wantAt)}`);
    }
    if (!ask.where.includes(got.where)) {
      failures.push(`reminder ${i + 1} where=${got.where}, want ${ask.where.join(' or ')}`);
    }
  });
  const gotCancel = [...new Set(reading.cancel)].sort().join(',');
  const wantCancel = [...(expect.cancel ?? [])].sort().join(',');
  if (gotCancel !== wantCancel) failures.push(`cancels [${gotCancel}], want [${wantCancel}]`);
  if (primaryTag(reading.language) !== expect.language) {
    failures.push(`language ${reading.language}, want ${expect.language}`);
  }
  return failures;
}

/**
 * The plan against the case, and the rules every plan must keep whatever the case: a
 * reminder asked for by someone who is not a Hale customer is never a 1:1 text (decision
 * 2026-10-21), nobody is texted 1:1 because someone else asked, a reminder for someone else
 * is tied to their seat in the chat, and nothing is due inside the quiet hours of where it
 * is going. `quietAt(planned)` answers the last with the runtime's own windows.
 */
export function planFailures(expect, plan, { askerIsCustomer, quietAt }) {
  const failures = [];
  const want = expect.plan ?? [];
  if (plan.set.length !== want.length) {
    failures.push(`${plan.set.length} reminders planned, want ${want.length}`);
  }
  want.forEach((w, i) => {
    const got = plan.set[i];
    if (!got) return;
    if (got.delivery !== w.delivery) {
      failures.push(`reminder ${i + 1} delivered ${got.delivery}, want ${w.delivery}`);
    }
    if (got.moved !== w.moved) {
      failures.push(`reminder ${i + 1} quiet-hours move ${got.moved}, want ${w.moved}`);
    }
    if (w.forUser !== undefined && got.forUserId !== w.forUser) {
      failures.push(`reminder ${i + 1} for ${got.forUserId}, want ${w.forUser}`);
    }
  });
  const wantAsk = expect.needsTime ?? 0;
  if (plan.needsTime.length !== wantAsk) {
    failures.push(`${plan.needsTime.length} asked when, want ${wantAsk}`);
  }
  const wantNotSet = expect.notSet ?? 0;
  if (plan.notSet.length !== wantNotSet) {
    failures.push(`${plan.notSet.length} not set, want ${wantNotSet}`);
  }
  for (const [i, got] of plan.set.entries()) {
    if (got.delivery === 'direct' && !askerIsCustomer) {
      failures.push(`reminder ${i + 1}: a non-customer's reminder would be texted 1:1`);
    }
    if (got.delivery === 'direct' && got.forKind !== 'sender') {
      failures.push(`reminder ${i + 1}: someone would be texted 1:1 because another person asked`);
    }
    if (got.forKind === 'person' && !got.forPhoneHash) {
      failures.push(`reminder ${i + 1}: for ${got.forName}, who has no seat in the chat`);
    }
    if (quietAt(got)) failures.push(`reminder ${i + 1}: due inside quiet hours`);
  }
  return failures;
}

/**
 * Fixed copy: two texts of one kind, written from different facts, that came out identical.
 * A model writing from facts never does that; a template always does.
 */
export function fixedCopyFailures(texts) {
  const byText = new Map();
  for (const entry of texts) {
    if (!entry.text) continue;
    const key = `${entry.kind}\n${entry.text.trim()}`;
    const group = byText.get(key) ?? [];
    group.push(entry);
    byText.set(key, group);
  }
  const failures = new Map();
  for (const group of byText.values()) {
    const distinctFacts = new Set(group.map((entry) => entry.factsKey)).size;
    if (distinctFacts < 2) continue;
    for (const entry of group) {
      failures.set(
        `${entry.id}:${entry.kind}`,
        `${entry.kind} text identical across ${group.length} cases with ${distinctFacts} different sets of facts (fixed copy)`,
      );
    }
  }
  return failures;
}

/**
 * --broken, the policy half: texts the asker 1:1 whenever the reminder is their own (customer
 * or not, whatever they said) and keeps the time they asked for through quiet hours.
 */
export function brokenPlan(plan) {
  return {
    ...plan,
    set: plan.set.map((planned) => ({
      ...planned,
      delivery: planned.forKind === 'sender' ? 'direct' : planned.delivery,
      deliverAt: planned.askedFor,
      moved: null,
    })),
  };
}

/** --broken, the voice half: one fixed line per kind, whatever the facts. */
export function brokenText(facts) {
  return facts.kind === 'confirm' ? 'Reminder set!' : `Reminder: ${facts.what}`;
}
