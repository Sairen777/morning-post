import { createSignal, Show } from "solid-js";
import type { DigestView, PublicDigestRun } from "../api/types";
import FormatTime from "./FormatTime";
import { validateDigestPeriod } from "./period";

interface DigestRunnerCardProps {
  onRun: (body: { periodStartMs?: number; periodEndMs?: number }) => Promise<DigestView>;
  onAuthError: () => void;
  activeRun: PublicDigestRun | undefined;
  isCheckingRunStatus: boolean;
  runStatusError: string | null;
  onRefreshRunStatus: () => Promise<void>;
  onOpenRuns: () => void;
}

export default function DigestRunnerCard(props: DigestRunnerCardProps) {
  const [start, setStart] = createSignal("");
  const [end, setEnd] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [isRefreshingRunStatus, setIsRefreshingRunStatus] = createSignal(false);

  const isRunBlocked = () =>
    isSubmitting() ||
    isRefreshingRunStatus() ||
    props.isCheckingRunStatus ||
    props.runStatusError !== null ||
    props.activeRun?.status === "running";

  const handleRefreshRunStatus = async () => {
    setIsRefreshingRunStatus(true);
    try {
      await props.onRefreshRunStatus();
    } finally {
      setIsRefreshingRunStatus(false);
    }
  };

  const handleRun = async (e: Event) => {
    e.preventDefault();
    setError(null);

    const result = validateDigestPeriod(start(), end());
    if (!result.valid) {
      setError(result.error);
      return;
    }

    setIsSubmitting(true);
    try {
      const digest = await props.onRun(result.body);
      if (digest.digest.status === "failed") {
        setError(
          digest.failureReason ??
            "The digest run failed. Please try again.",
        );
      }
    } catch (err: unknown) {
      const status = err instanceof Error && "status" in err &&
          typeof err.status === "number"
        ? err.status
        : undefined;
      if (status === 401) {
        props.onAuthError();
      } else if (status === 409) {
        await props.onRefreshRunStatus().catch(() => undefined);
        setError(
          "A digest is already running. Wait for it to finish before starting another digest.",
        );
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("An unexpected error occurred");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div class="card">
      <div class="card-header">
        <h2>Run Digest</h2>
      </div>
      <Show when={props.isCheckingRunStatus}>
        <p role="status" aria-live="polite">
          Checking whether a digest is already running…
        </p>
      </Show>
      <Show when={!props.isCheckingRunStatus && props.activeRun?.status === "running"}>
        <div role="status" aria-live="polite">
          <p>
            <strong>A digest is running.</strong>
          </p>
          <p>
            Started <FormatTime ms={props.activeRun?.startedAt ?? 0} />.
          </p>
          <button type="button" onClick={props.onOpenRuns}>
            Open Runs tab
          </button>
        </div>
      </Show>
      <Show when={props.runStatusError !== null}>
        <div class="error" role="alert">
          <p>{props.runStatusError}</p>
          <button
            type="button"
            onClick={() => void handleRefreshRunStatus()}
            disabled={isRefreshingRunStatus()}
          >
            {isRefreshingRunStatus() ? "Checking…" : "Retry status check"}
          </button>
        </div>
      </Show>
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
        <Show when={error() !== null}>
          <div class="error" role="alert">{error()}</div>
        </Show>
        <div class="form-actions">
          <button type="submit" class="primary" disabled={isRunBlocked()}>
            {props.isCheckingRunStatus
              ? "Checking run status…"
              : isSubmitting()
              ? "Running…"
              : "Run digest"}
          </button>
        </div>
      </form>
    </div>
  );
}

