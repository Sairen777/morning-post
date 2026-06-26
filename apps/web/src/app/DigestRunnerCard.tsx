import { createSignal } from "solid-js";
import { validateDigestPeriod } from "./period";

interface DigestRunnerCardProps {
  onRun: (body: { periodStartMs?: number; periodEndMs?: number }) => Promise<void>;
  onAuthError: () => void;
}

export default function DigestRunnerCard(props: DigestRunnerCardProps) {
  const [start, setStart] = createSignal("");
  const [end, setEnd] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [running, setRunning] = createSignal(false);

  const handleRun = async (e: Event) => {
    e.preventDefault();
    setError(null);

    const result = validateDigestPeriod(start(), end());
    if (!result.valid) {
      setError(result.error);
      return;
    }

    setRunning(true);
    try {
      await props.onRun(result.body);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "status" in err &&
        (err as { status: number }).status === 401
      ) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("An unexpected error occurred");
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <div class="card">
      <div class="card-header">
        <h2>Run Digest</h2>
      </div>
      <form onSubmit={handleRun}>
        <div class="form-row">
          <div class="form-group">
            <label for="period-start">Period start</label>
            <input
              id="period-start"
              type="datetime-local"
              value={start()}
              onInput={(e) => setStart(e.currentTarget.value)}
            />
          </div>
          <div class="form-group">
            <label for="period-end">Period end</label>
            <input
              id="period-end"
              type="datetime-local"
              value={end()}
              onInput={(e) => setEnd(e.currentTarget.value)}
            />
          </div>
        </div>
        {error() && <div class="error">{error()}</div>}
        <div class="form-actions">
          <button type="submit" class="primary" disabled={running()}>
            {running() ? "Running…" : "Run digest"}
          </button>
        </div>
      </form>
    </div>
  );
}
