import assert from "node:assert/strict";
import { test } from "vitest";
import {
  tokenUsageCounters,
  ZERO_TOKEN_USAGE,
} from "../../src/core/token-usage.js";
import { EventNormalizer } from "../../src/http/chat-normalize.js";

/** Malformed synthetic values that cannot represent an exact token count. */
const invalid = [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1];
/** Valid last-request counters used only by the offline normalizer. */
const last = {
  inputTokens: 10,
  outputTokens: 2,
  totalTokens: 12,
  cachedInputTokens: 1,
  reasoningOutputTokens: 0,
};

test.each(invalid)(
  "invalid required counts are omitted consistently: %s",
  (value) => {
    const events = new EventNormalizer().normalize(
      "thread/tokenUsage/updated",
      { tokenUsage: { last: { ...last, inputTokens: value } } },
    );
    assert.deepEqual(events, []);
    assert.equal(
      tokenUsageCounters({ ...ZERO_TOKEN_USAGE, inputTokens: value }),
      undefined,
    );
  },
);

test.each(invalid)(
  "invalid optional counts do not corrupt valid usage: %s",
  (value) => {
    const events = new EventNormalizer().normalize(
      "thread/tokenUsage/updated",
      {
        tokenUsage: {
          last: {
            ...last,
            cachedInputTokens: value,
            reasoningOutputTokens: value,
          },
        },
      },
    );
    assert.deepEqual(events[0]?.usage, {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
    });
  },
);

test("exact zero counters remain available rather than being treated as missing", () => {
  assert.deepEqual(tokenUsageCounters(ZERO_TOKEN_USAGE), ZERO_TOKEN_USAGE);
  const events = new EventNormalizer().normalize("thread/tokenUsage/updated", {
    tokenUsage: { last: ZERO_TOKEN_USAGE },
  });
  assert.deepEqual(events[0]?.usage, {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  });
});
