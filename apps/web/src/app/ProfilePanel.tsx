import { createSignal, For, Show } from "solid-js";
import type {
  InterestRuleDisposition,
  InterestRuleKind,
  PublicInterestRule,
  PublicUser,
} from "../api/types";
import { ApiClientError } from "../api/client";

interface ProfilePanelProps {
  user: PublicUser;
  interests: PublicInterestRule[];
  interestsLoading: boolean;
  interestMutationId: string | null;
  interestsError: string | null;
  onSave: (input: {
    name?: string;
    systemPrompt?: string;
    summaryPrompt?: string;
    defaultLanguage?: string | null;
    defaultRelevanceFilterMode?: "personalized" | "include_all";
    relevanceThreshold?: number;
    maximumStoriesPerDigest?: number | null;
  }) => Promise<PublicUser>;
  onCreateInterest: (input: {
    label: string;
    kind: InterestRuleKind;
    disposition: InterestRuleDisposition;
    expiresAt?: number | null;
  }) => Promise<void>;
  onUpdateInterest: (
    id: string,
    input: Partial<{
      label: string;
      kind: InterestRuleKind;
      disposition: InterestRuleDisposition;
      expiresAt: number | null;
    }>,
  ) => Promise<void>;
  onDeleteInterest: (id: string) => Promise<void>;
  onSaved: (user: PublicUser) => void;
  onAuthError: () => void;
}

type RuleDraft = {
  label: string;
  kind: InterestRuleKind;
  disposition: InterestRuleDisposition;
  expiresAt: string;
};

const kindLabel: Record<InterestRuleKind, string> = {
  topic: "Topic",
  entity: "Entity",
  phrase: "Phrase",
  story_type: "Story type",
};

const dispositionLabel: Record<InterestRuleDisposition, string> = {
  prioritize: "Prioritize",
  show_less: "Show less",
  mute: "Muted",
};

function dateInputValue(expiresAt: number | null): string {
  return expiresAt === null ? "" : new Date(expiresAt).toISOString().slice(0, 10);
}

export default function ProfilePanel(props: ProfilePanelProps) {
  const [name, setName] = createSignal(props.user.name);
  const [systemPrompt, setSystemPrompt] = createSignal(props.user.systemPrompt);
  const [summaryPrompt, setSummaryPrompt] = createSignal(props.user.summaryPrompt);
  const [defaultLanguage, setDefaultLanguage] = createSignal(
    props.user.defaultLanguage ?? "",
  );
  const [defaultRelevanceFilterMode, setDefaultRelevanceFilterMode] =
    createSignal(props.user.defaultRelevanceFilterMode);
  const [relevanceThreshold, setRelevanceThreshold] = createSignal(
    String(props.user.relevanceThreshold),
  );
  const [maximumStoriesPerDigest, setMaximumStoriesPerDigest] = createSignal(
    props.user.maximumStoriesPerDigest === null
      ? ""
      : String(props.user.maximumStoriesPerDigest),
  );
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [newLabel, setNewLabel] = createSignal("");
  const [newKind, setNewKind] = createSignal<InterestRuleKind>("topic");
  const [newDisposition, setNewDisposition] =
    createSignal<InterestRuleDisposition>("prioritize");
  const [newExpiresAt, setNewExpiresAt] = createSignal("");
  const [ruleDrafts, setRuleDrafts] = createSignal<Record<string, RuleDraft>>({});
  const [interestFormError, setInterestFormError] = createSignal<string | null>(
    null,
  );

  const thresholdDescription = () => {
    const threshold = Number(relevanceThreshold());
    if (threshold >= 75) return "Focused — only the strongest matches";
    if (threshold <= 44) return "Broad — include more possible matches";
    return "Balanced — a middle ground";
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const threshold = Number(relevanceThreshold());
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) {
      setError("Relevance threshold must be a whole number from 0 to 100.");
      return;
    }
    const maximum = maximumStoriesPerDigest().trim() === ""
      ? null
      : Number(maximumStoriesPerDigest());
    if (
      maximum !== null &&
      (!Number.isInteger(maximum) || maximum <= 0)
    ) {
      setError("Maximum stories must be a positive whole number or blank.");
      return;
    }
    setSaving(true);
    try {
      const updatedUser = await props.onSave({
        name: name(),
        systemPrompt: systemPrompt(),
        summaryPrompt: summaryPrompt(),
        defaultLanguage: defaultLanguage().trim() === ""
          ? null
          : defaultLanguage(),
        defaultRelevanceFilterMode: defaultRelevanceFilterMode(),
        relevanceThreshold: threshold,
        maximumStoriesPerDigest: maximum,
      });
      props.onSaved(updatedUser);
      setSaved(true);
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("An unexpected error occurred");
      }
    } finally {
      setSaving(false);
    }
  };

  const draftFor = (rule: PublicInterestRule): RuleDraft =>
    ruleDrafts()[rule.id] ?? {
      label: rule.label,
      kind: rule.kind,
      disposition: rule.disposition,
      expiresAt: dateInputValue(rule.expiresAt),
    };

  const updateDraft = (rule: PublicInterestRule, patch: Partial<RuleDraft>) => {
    setRuleDrafts((drafts) => ({
      ...drafts,
      [rule.id]: { ...draftFor(rule), ...patch },
    }));
  };

  const saveRule = async (rule: PublicInterestRule) => {
    const draft = draftFor(rule);
    if (draft.label.trim() === "") {
      setInterestFormError("Interest labels cannot be blank.");
      return;
    }
    setInterestFormError(null);
    try {
      await props.onUpdateInterest(rule.id, {
        label: draft.label.trim(),
        kind: draft.kind,
        disposition: draft.disposition,
        expiresAt: draft.disposition === "mute" && draft.expiresAt !== ""
          ? Date.parse(draft.expiresAt)
          : null,
      });
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setInterestFormError(err.message);
      }
    }
  };

  const addInterest = async (e: Event) => {
    e.preventDefault();
    const label = newLabel().trim();
    if (label === "") {
      setInterestFormError("Enter a topic, entity, phrase, or story type.");
      return;
    }
    setInterestFormError(null);
    try {
      await props.onCreateInterest({
        label,
        kind: newKind(),
        disposition: newDisposition(),
        expiresAt: newDisposition() === "mute" && newExpiresAt() !== ""
          ? Date.parse(newExpiresAt())
          : null,
      });
      setNewLabel("");
      setNewExpiresAt("");
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setInterestFormError(err.message);
      }
    }
  };

  const removeInterest = async (rule: PublicInterestRule) => {
    setInterestFormError(null);
    try {
      await props.onDeleteInterest(rule.id);
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setInterestFormError(err.message);
      }
    }
  };

  const renderRules = (rules: PublicInterestRule[]) => (
    <Show
      when={rules.length > 0}
      fallback={<p class="hint">No active rules in this section.</p>}
    >
      <For each={rules}>
        {(rule) => {
          const draft = () => draftFor(rule);
          const isMutating = () => props.interestMutationId === rule.id;
          return (
            <div class="card" style="margin-bottom: 0.75rem;">
              <div style="display: flex; justify-content: space-between; gap: 1rem; align-items: baseline;">
                <strong>{rule.label}</strong>
                <span class="badge">
                  {rule.origin === "inferred" ? "Inferred" : "Explicit"}
                </span>
              </div>
              <div class="hint" style="margin: 0.25rem 0 0.75rem;">
                {kindLabel[rule.kind]} · {dispositionLabel[rule.disposition]}
                <Show when={rule.expiresAt !== null}>
                  {" "}· Expires {new Date(rule.expiresAt!).toLocaleDateString()}
                </Show>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label for={`interest-label-${rule.id}`}>Label</label>
                  <input
                    id={`interest-label-${rule.id}`}
                    value={draft().label}
                    onInput={(e) => updateDraft(rule, { label: e.currentTarget.value })}
                  />
                </div>
                <div class="form-group">
                  <label for={`interest-kind-${rule.id}`}>Type</label>
                  <select
                    id={`interest-kind-${rule.id}`}
                    value={draft().kind}
                    onChange={(e) =>
                      updateDraft(rule, { kind: e.currentTarget.value as InterestRuleKind })}
                  >
                    <option value="topic">Topic</option>
                    <option value="entity">Entity</option>
                    <option value="phrase">Phrase</option>
                    <option value="story_type">Story type</option>
                  </select>
                </div>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label for={`interest-disposition-${rule.id}`}>Disposition</label>
                  <select
                    id={`interest-disposition-${rule.id}`}
                    value={draft().disposition}
                    onChange={(e) => {
                      const disposition = e.currentTarget.value as InterestRuleDisposition;
                      updateDraft(rule, {
                        disposition,
                        expiresAt: disposition === "mute" ? draft().expiresAt : "",
                      });
                    }}
                  >
                    <option value="prioritize">Prioritize</option>
                    <option value="show_less">Show less</option>
                    <option value="mute">Muted</option>
                  </select>
                </div>
                <Show when={draft().disposition === "mute"}>
                  <div class="form-group">
                    <label for={`interest-expiry-${rule.id}`}>Mute expires (optional)</label>
                    <input
                      id={`interest-expiry-${rule.id}`}
                      type="date"
                      value={draft().expiresAt}
                      onInput={(e) =>
                        updateDraft(rule, { expiresAt: e.currentTarget.value })}
                    />
                  </div>
                </Show>
              </div>
              <div class="form-row" style="gap: 0.5rem;">
                <button
                  type="button"
                  class="primary"
                  disabled={isMutating()}
                  onClick={() => saveRule(rule)}
                >
                  {isMutating() ? "Saving…" : "Save rule"}
                </button>
                <button
                  type="button"
                  disabled={isMutating()}
                  onClick={() => removeInterest(rule)}
                >
                  {rule.disposition === "mute" ? "Unmute" : "Remove"}
                </button>
              </div>
            </div>
          );
        }}
      </For>
    </Show>
  );

  const rulesFor = (disposition: InterestRuleDisposition) =>
    props.interests.filter((rule) => rule.disposition === disposition && rule.state === "active");

  return (
    <div class="card">
      <div class="card-header">
        <h2>Profile</h2>
      </div>
      <form onSubmit={handleSubmit}>
        <div class="form-group">
          <label for="profile-name">Name</label>
          <input
            id="profile-name"
            type="text"
            required
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="profile-language">Default language</label>
            <input
              id="profile-language"
              type="text"
              value={defaultLanguage()}
              onInput={(e) => setDefaultLanguage(e.currentTarget.value)}
            />
            <div class="hint">e.g. English, Spanish. Leave blank for auto-detection.</div>
          </div>
        </div>
        <div class="form-group">
          <label for="profile-prompt">Interest instructions</label>
          <textarea
            id="profile-prompt"
            rows={4}
            value={systemPrompt()}
            onInput={(e) => setSystemPrompt(e.currentTarget.value)}
          />
          <div class="hint">
            Advanced context for deciding which stories match your interests.
          </div>
        </div>
        <div class="form-group">
          <label for="profile-summary-prompt">Summary writing instructions</label>
          <textarea
            id="profile-summary-prompt"
            rows={4}
            value={summaryPrompt()}
            onInput={(e) => setSummaryPrompt(e.currentTarget.value)}
          />
          <div class="hint">
            Guide tone, detail, and format without changing relevance filtering.
          </div>
        </div>
        <section class="section-title" aria-labelledby="profile-filter-heading">
          <h3 id="profile-filter-heading">Relevance and digest size</h3>
          <p class="hint">Choose how broadly stories are filtered before your digest is built.</p>
          <div class="form-group">
            <label for="profile-relevance-mode">Default filtering mode</label>
            <select
              id="profile-relevance-mode"
              value={defaultRelevanceFilterMode()}
              onChange={(e) =>
                setDefaultRelevanceFilterMode(e.currentTarget.value as "personalized" | "include_all")}
            >
              <option value="personalized">Personalized — use my interests</option>
              <option value="include_all">Include all — do not filter by relevance</option>
            </select>
          </div>
          <div class="form-group">
            <label for="profile-threshold">Relevance threshold: {relevanceThreshold()}</label>
            <input
              id="profile-threshold"
              type="range"
              min="0"
              max="100"
              step="1"
              value={relevanceThreshold()}
              onInput={(e) => setRelevanceThreshold(e.currentTarget.value)}
            />
            <div class="hint">{thresholdDescription()}</div>
          </div>
          <div class="form-group">
            <label for="profile-max-stories">Maximum stories per digest (optional)</label>
            <input
              id="profile-max-stories"
              type="number"
              min="1"
              step="1"
              placeholder="No limit"
              value={maximumStoriesPerDigest()}
              onInput={(e) => setMaximumStoriesPerDigest(e.currentTarget.value)}
            />
          </div>
        </section>
        <Show when={error()}>
          <div class="error">{error()}</div>
        </Show>
        <Show when={saved()}>
          <div class="hint">Profile saved</div>
        </Show>
        <div class="form-actions">
          <button type="submit" class="primary" disabled={saving()}>
            {saving() ? "Saving…" : "Save profile"}
          </button>
        </div>
      </form>

      <section class="section-title" aria-labelledby="interests-heading">
        <h3 id="interests-heading">Interest profile</h3>
        <p class="hint">Rules shape relevance. Inferred rules come from your reading patterns; explicit rules are yours.</p>
        <Show when={props.interestsError}>
          <div class="error">{props.interestsError}</div>
        </Show>
        <Show
          when={!props.interestsLoading}
          fallback={<p class="hint">Loading interest profile…</p>}
        >
          <section aria-labelledby="prioritize-heading">
            <h4 id="prioritize-heading">Prioritize</h4>
            {renderRules(rulesFor("prioritize"))}
          </section>
          <section aria-labelledby="show-less-heading">
            <h4 id="show-less-heading">Show less</h4>
            {renderRules(rulesFor("show_less"))}
          </section>
          <section
            aria-labelledby="muted-heading"
            style="padding: 0.75rem; border: 1px solid var(--border); border-radius: var(--radius);"
          >
            <h4 id="muted-heading">Muted</h4>
            <p class="hint">Muted rules are hard exclusions and are kept separate from ranking preferences.</p>
            {renderRules(rulesFor("mute"))}
          </section>
        </Show>
      </section>

      <section class="section-title" aria-labelledby="add-interest-heading">
        <h3 id="add-interest-heading">Add a rule</h3>
        <p class="hint">Add a topic, entity, phrase, or story type to your profile.</p>
        <form onSubmit={addInterest}>
          <div class="form-row">
            <div class="form-group">
              <label for="interest-label">Topic, entity, phrase, or story type</label>
              <input
                id="interest-label"
                required
                value={newLabel()}
                onInput={(e) => setNewLabel(e.currentTarget.value)}
              />
            </div>
            <div class="form-group">
              <label for="interest-kind">Type</label>
              <select
                id="interest-kind"
                value={newKind()}
                onChange={(e) => setNewKind(e.currentTarget.value as InterestRuleKind)}
              >
                <option value="topic">Topic</option>
                <option value="entity">Entity</option>
                <option value="phrase">Phrase</option>
                <option value="story_type">Story type</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label for="interest-disposition">Disposition</label>
              <select
                id="interest-disposition"
                value={newDisposition()}
                onChange={(e) =>
                  setNewDisposition(e.currentTarget.value as InterestRuleDisposition)}
              >
                <option value="prioritize">Prioritize</option>
                <option value="show_less">Show less</option>
                <option value="mute">Muted</option>
              </select>
            </div>
            <Show when={newDisposition() === "mute"}>
              <div class="form-group">
                <label for="interest-expiry">Mute expires (optional)</label>
                <input
                  id="interest-expiry"
                  type="date"
                  value={newExpiresAt()}
                  onInput={(e) => setNewExpiresAt(e.currentTarget.value)}
                />
              </div>
            </Show>
          </div>
          <Show when={interestFormError()}>
            <div class="error">{interestFormError()}</div>
          </Show>
          <button
            type="submit"
            class="primary"
            disabled={props.interestMutationId === "new"}
          >
            {props.interestMutationId === "new" ? "Adding…" : "Add rule"}
          </button>
        </form>
      </section>
    </div>
  );
}
