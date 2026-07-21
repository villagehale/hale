/**
 * The one prompt-bar spec — the "ask Hale in your own words" input shared by the Ask
 * composer and the Village AI search. One radius / type-size / send-button dimension so
 * the two read as the same system element, not two arbitrary re-implementations.
 */
export const PROMPT_BAR_CONTAINER = 'rounded-[18px] border-[1.5px] border-rule-strong bg-card';
export const PROMPT_BAR_INPUT = 'text-[16px] leading-[22px]';
/** 40pt send/action button (≥44pt with its row padding) at the shared corner radius. */
export const PROMPT_BAR_ACTION = 'h-10 w-10 items-center justify-center rounded-[14px]';
