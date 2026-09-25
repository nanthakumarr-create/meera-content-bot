// Any test that reaches the real network is a bug: every external service is mocked.
globalThis.fetch = (async (input: unknown) => {
  const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
  throw new Error(
    `Real network access is disabled in tests (attempted ${url.replace(/bot[^/]+/, "bot***")})`,
  );
}) as typeof fetch;
