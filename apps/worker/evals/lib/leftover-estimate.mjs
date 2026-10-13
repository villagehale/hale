import { cacheGet, cacheKey, isVerdict } from './harness.mjs';

/**
 * The general-answer calls a fresh recording would still send.
 *
 * A hit is skipped. When the sanitize for a fixture is cached, the search, the
 * compose and the judge are looked up under the same keys the live runner uses.
 * When it is not, the downstream is the estimate's predicted reading (a prior
 * sanitize of a similar question, or a search unless the fixture expects the
 * safety door) and those keys are not looked up: the reading that would name
 * them has not been recorded. A search miss leaves the notes unknown, so the
 * compose and the judge after it are priced the same way.
 */
export async function leftoverGeneralAnswerCalls(ctx) {
  const {
    request,
    fixtures,
    sanitizeLane,
    subjectLane,
    searchModel,
    composeModel,
    judgeModel,
    sanitizeSkill,
    searchSkill,
    skill,
    draws,
    today,
    maxSearches,
    judgeSystem,
    verdictSchema,
    brokenAnswer,
    nearMissTail,
    calibrationId,
    drawTag,
    flatten,
    priorReading,
    homePlace,
    notesBlob,
    typicalAnswer,
    sanitizeChars,
    answerChars,
    judgeChars,
    noteChars,
  } = ctx;

  const calls = [];
  const priced = new Set();
  const shortIds = [];
  let searchTurns = 0;

  function add(key, call) {
    if (priced.has(key)) return false;
    priced.add(key);
    calls.push(call);
    return true;
  }

  function sanitizeCall(user) {
    return {
      model: sanitizeLane.model,
      promptCache: true,
      prefixId: 'sanitize',
      prefix: `${sanitizeSkill.instructions}\n${JSON.stringify(request.sanitizeJsonSchema)}`,
      user,
      outputChars: sanitizeChars,
    };
  }

  function searchCall(user) {
    return {
      model: searchModel,
      promptCache: false,
      prefixId: 'search',
      prefix: `${searchSkill.instructions}\n${JSON.stringify({
        name: 'web_search',
        type: 'web_search_20250305',
        max_uses: maxSearches,
      })}`,
      user,
      outputChars: noteChars,
    };
  }

  function composeCall(user) {
    return {
      model: composeModel,
      promptCache: true,
      prefixId: 'compose',
      prefix: `${skill.instructions}\n${JSON.stringify(request.answerJsonSchema)}`,
      user,
      outputChars: answerChars,
    };
  }

  function judgeCall(payload) {
    return {
      model: judgeModel,
      promptCache: true,
      prefixId: 'judge',
      prefix: `${judgeSystem}\n${JSON.stringify(verdictSchema)}`,
      user: JSON.stringify(payload),
      outputChars: judgeChars,
    };
  }

  async function toolRecord(tag, fields) {
    const modelId = fields.lane?.model ?? fields.model;
    const canonical = JSON.stringify({
      model: modelId,
      system: fields.system,
      userMessage: fields.userMessage,
      toolName: fields.toolName,
      toolSchema: fields.toolSchema,
      ...(fields.lane ? { lane: fields.lane } : {}),
    });
    const key = cacheKey(tag, canonical);
    return { key, cached: (await cacheGet(key)) ?? null };
  }

  async function searchRecord(tag, userMessage) {
    const canonical = JSON.stringify({
      model: searchModel,
      system: searchSkill.instructions,
      userMessage,
      tool: 'web_search_20250305',
      maxUses: maxSearches,
    });
    const key = cacheKey(tag, canonical);
    return { key, cached: (await cacheGet(key)) ?? null };
  }

  async function judgeRecord(tag, payload) {
    const userMessage = JSON.stringify(payload);
    const key = cacheKey(
      `general-answer:judge:${tag}`,
      `${judgeModel}\n${judgeSystem}\n${userMessage}\n${JSON.stringify(verdictSchema)}`,
    );
    const cached = await cacheGet(key);
    return { key, hit: Boolean(cached && isVerdict(cached.parsed)) };
  }

  function fallbackReading(fixture) {
    const door = fixture.expectSafetyDoor !== undefined;
    return {
      question: fixture.text,
      needs_search: door ? 'no' : 'yes',
      their_place: 'not_needed',
      missing_detail: 'none',
      language: 'en',
      sensitive: door ? 'yes' : 'no',
    };
  }

  function judgePayload(fixture, found, answer) {
    return {
      question: fixture.text,
      today,
      answer,
      live: request.liveAsTold(found.search),
      research_notes: found.search === 'searched' ? found.notes : 'none',
      watchFor: fixture.watchFor,
    };
  }

  async function resolveSearch(fixture, value, lookup) {
    const question = request.scrubDirectIdentifiers(String(value.question ?? '').trim());
    const missing = request.scrubDirectIdentifiers(String(value.missing_detail ?? '').trim());
    const language = ctx.normalizeLanguage(value.language);
    const lit = !fixture.searchOff;
    const searching = request.needsSearch(value.needs_search);
    const place =
      lit && searching && request.turnsOnTheirPlace(value.their_place)
        ? await homePlace(fixture, request.questionIsSensitive(value.sensitive))
        : null;
    let search = 'not_needed';
    let notes = '';
    let searchMiss = null;
    if (fixture.research !== undefined) {
      search = 'searched';
      notes = fixture.research.notes;
    } else if (!searching) {
      search = 'not_needed';
    } else if (lit && value.needs_search === 'missing_detail' && place === null) {
      search = 'missing_detail';
    } else if (!lit) {
      search = 'search_off';
    } else {
      const userMessage = request.searchUserMessage({ question, today, place });
      if (!lookup) {
        search = 'searched';
        notes = notesBlob;
        searchMiss = {
          key: `predicted:${fixture.id}:search`,
          user: userMessage,
          unknownNotes: true,
        };
      } else {
        const rec = await searchRecord(`general-answer-search:${fixture.id}`, userMessage);
        if (!rec.cached) {
          search = 'searched';
          notes = notesBlob;
          searchMiss = { key: rec.key, user: userMessage, unknownNotes: true };
        } else if (
          rec.cached.stopReason !== 'end_turn' ||
          !Array.isArray(rec.cached.urls) ||
          rec.cached.urls.length === 0 ||
          rec.cached.notes === ''
        ) {
          search = 'nothing_usable';
        } else {
          search = 'searched';
          notes = rec.cached.notes;
        }
      }
    }
    return { question, missing, language, search, notes, searchMiss };
  }

  async function priceDraws(fixture, found, lookup) {
    if (found.searchMiss && add(found.searchMiss.key, searchCall(found.searchMiss.user))) {
      searchTurns += 1;
    }
    const unknown = !lookup || found.searchMiss?.unknownNotes === true;
    for (let draw = 0; draw < draws; draw += 1) {
      const user = request.generalAnswerUserMessage({
        question: found.question,
        language: found.language,
        today,
        search: found.search,
        notes: found.notes,
        missing: found.missing,
      });
      if (unknown) {
        add(`predicted:${fixture.id}:compose:${draw}`, composeCall(user));
        if (fixture.expectSafetyDoor !== undefined) continue;
        add(
          `predicted:${fixture.id}:judge:${draw}`,
          judgeCall(judgePayload(fixture, found, typicalAnswer)),
        );
        continue;
      }
      const rec = await toolRecord(`general-answer:${drawTag(fixture.id, draw)}`, {
        lane: subjectLane,
        system: skill.instructions,
        userMessage: user,
        toolName: 'answer',
        toolSchema: request.answerJsonSchema,
      });
      if (!rec.cached) {
        add(rec.key, composeCall(user));
        if (fixture.expectSafetyDoor !== undefined) continue;
        add(
          `predicted:${fixture.id}:judge-after-compose-miss:${draw}`,
          judgeCall(judgePayload(fixture, found, typicalAnswer)),
        );
        continue;
      }
      const kind = request.hurtIllOrDanger(rec.cached.value?.hurt_ill_or_danger);
      if (kind !== null) continue;
      const flattened = flatten(String(rec.cached.value?.answer ?? ''));
      const judged = await judgeRecord(
        drawTag(fixture.id, draw),
        judgePayload(fixture, found, flattened),
      );
      if (!judged.hit) add(judged.key, judgeCall(judgePayload(fixture, found, flattened)));
    }
  }

  async function sanitizeRecord(fixture, pending) {
    const userMessage = request.questionSanitizeUserMessage(fixture.text, pending);
    const rec = await toolRecord(`general-answer-sanitize:${fixture.id}`, {
      lane: sanitizeLane,
      system: sanitizeSkill.instructions,
      userMessage,
      toolName: 'sanitize',
      toolSchema: request.sanitizeJsonSchema,
    });
    return { ...rec, userMessage };
  }

  function momentCall(user) {
    return {
      model: ctx.momentLane.model,
      promptCache: true,
      prefixId: 'moment',
      prefix: `${ctx.momentSkill.instructions}\n${JSON.stringify(ctx.momentJsonSchema)}`,
      user,
      outputChars: 220,
      group: 'moment',
    };
  }

  async function priceMoment(fixture) {
    const before = calls.length;
    for (let draw = 0; draw < draws; draw += 1) {
      const user = ctx.momentUserMessage(fixture.directMoment, fixture.text);
      const rec = await toolRecord(`general-answer-moment:${drawTag(fixture.id, draw)}`, {
        lane: ctx.momentLane,
        system: ctx.momentSkill.instructions,
        userMessage: user,
        toolName: 'moment_reply',
        toolSchema: ctx.momentJsonSchema,
      });
      const found = { search: 'not_needed', notes: '' };
      if (!rec.cached) {
        add(rec.key, momentCall(user));
        add(`predicted:${fixture.id}:moment-judge:${draw}`, {
          ...judgeCall(judgePayload(fixture, found, typicalAnswer)),
          group: 'moment',
        });
        continue;
      }
      const flattened = flatten(String(rec.cached.value?.reply ?? ''));
      const judged = await judgeRecord(
        drawTag(fixture.id, draw),
        judgePayload(fixture, found, flattened),
      );
      if (!judged.hit) {
        add(judged.key, {
          ...judgeCall(judgePayload(fixture, found, flattened)),
          group: 'moment',
        });
      }
    }
    if (calls.length > before) shortIds.push(fixture.id);
  }

  async function priceFixture(fixture) {
    if (fixture.directMoment) {
      await priceMoment(fixture);
      return;
    }
    const before = calls.length;
    const pending = fixture.pending ?? null;
    const first = await sanitizeRecord(fixture, pending);
    if (!first.cached) {
      add(first.key, sanitizeCall(first.userMessage));
      if (pending !== null && fixture.expectAnswersPending === false) {
        const alone = request.questionSanitizeUserMessage(fixture.text, null);
        add(`predicted:${fixture.id}:sanitize-alone`, sanitizeCall(alone));
      }
      const value = priorReading(fixture) ?? fallbackReading(fixture);
      await priceDraws(fixture, await resolveSearch(fixture, value, false), false);
    } else {
      const answersPending =
        pending === null ? null : request.answersPending(first.cached.value?.answers_pending);
      if (answersPending === false) {
        const second = await sanitizeRecord(fixture, null);
        if (!second.cached) {
          add(second.key, sanitizeCall(second.userMessage));
          const value = priorReading(fixture) ?? fallbackReading(fixture);
          await priceDraws(fixture, await resolveSearch(fixture, value, false), false);
        } else {
          await priceDraws(fixture, await resolveSearch(fixture, second.cached.value, true), true);
        }
      } else {
        await priceDraws(fixture, await resolveSearch(fixture, first.cached.value, true), true);
      }
    }
    if (calls.length > before) shortIds.push(fixture.id);
  }

  for (const fixture of fixtures) await priceFixture(fixture);

  const calibration = fixtures.find((fixture) => fixture.id === calibrationId);
  const calibrationSanitize = await sanitizeRecord(calibration, calibration.pending ?? null);
  if (!calibrationSanitize.cached) {
    const standIn = {
      question: calibration.text,
      search: 'searched',
      notes: notesBlob,
      watchFor: calibration.watchFor,
    };
    add(
      'predicted:calibration:broken',
      judgeCall(judgePayload(calibration, standIn, flatten(brokenAnswer))),
    );
    add(
      'predicted:calibration:near',
      judgeCall(judgePayload(calibration, standIn, `${typicalAnswer} ${nearMissTail}`)),
    );
  } else {
    const found = await resolveSearch(calibration, calibrationSanitize.cached.value, true);
    if (found.searchMiss?.unknownNotes === true) {
      const standIn = {
        question: calibration.text,
        search: 'searched',
        notes: notesBlob,
        watchFor: calibration.watchFor,
      };
      add(
        'predicted:calibration:broken',
        judgeCall(judgePayload(calibration, standIn, flatten(brokenAnswer))),
      );
      add(
        'predicted:calibration:near',
        judgeCall(judgePayload(calibration, standIn, `${typicalAnswer} ${nearMissTail}`)),
      );
    } else {
      const broken = judgePayload(calibration, found, flatten(brokenAnswer));
      const brokenHit = await judgeRecord(`calibration:${calibration.id}`, broken);
      if (!brokenHit.hit) add(brokenHit.key, judgeCall(broken));
      const composeUser = request.generalAnswerUserMessage({
        question: found.question,
        language: found.language,
        today,
        search: found.search,
        notes: found.notes,
        missing: found.missing,
      });
      const composed = await toolRecord(`general-answer:${calibration.id}`, {
        lane: subjectLane,
        system: skill.instructions,
        userMessage: composeUser,
        toolName: 'answer',
        toolSchema: request.answerJsonSchema,
      });
      if (!composed.cached) {
        add(
          'predicted:calibration:near',
          judgeCall(judgePayload(calibration, found, `${typicalAnswer} ${nearMissTail}`)),
        );
      } else {
        const kind = request.hurtIllOrDanger(composed.cached.value?.hurt_ill_or_danger);
        const flattened = kind !== null ? '' : flatten(String(composed.cached.value?.answer ?? ''));
        const near = judgePayload(calibration, found, `${flattened} ${nearMissTail}`);
        const nearHit = await judgeRecord(`calibration-near-miss:${calibration.id}`, near);
        if (!nearHit.hit) add(nearHit.key, judgeCall(near));
      }
    }
  }

  return { calls, searchTurns, shortIds };
}
