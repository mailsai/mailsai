// The lines a user writes: Playwright's test with the mails fixture added.
import { test as base, expect } from "@playwright/test";
import { mailsFixtures } from "@mailsai/playwright";

export const test = base.extend(mailsFixtures());
export { expect };

/** What the stub knows about a sign-up: the code and token of the real email and of the decoy. */
export type SignupState = { code: string; token: string; decoyAddress: string; decoyCode: string; decoyToken: string };

/** A wait call the stub saw for an address: what it asked to hold for, and how it answered. */
export type StubCall = { timeout: number; has: string | null; since: string | null; status: number };

/** The error a promise rejects with; throws when it does not reject. */
export async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the wait to fail, but it did not");
}

/** Throws when `text` contains the run's API key. A plain check, not expect(): Playwright records
 *  an expect()'s arguments in the trace, and the key must appear in no trace. */
export function keyIsNotIn(text: string): void {
  const key = process.env.MAILS_API_KEY;
  if (!key) throw new Error("MAILS_API_KEY is not set for this run, so there is no key to look for");
  if (text.includes(key)) throw new Error("the text contains the API key");
}
