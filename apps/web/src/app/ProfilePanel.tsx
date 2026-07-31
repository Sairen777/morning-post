import { createSignal, For, Show } from "solid-js";
import type {
  DigestRunDetail,
  InterestRuleDisposition,
  InterestRuleKind,
  PublicDigestRun,
  PublicInterestRule,
  PublicUser,
  StoryDetailLevel,
} from "../api/types";
import { DEFAULT_MAXIMUM_STORIES_PER_DIGEST } from "../../../../src/constants";
import { ApiClientError } from "../api/client";
import DigestRunsPanel from "./DigestRunsPanel";

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
    storyDetailLevel?: StoryDetailLevel;
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
  runs?: PublicDigestRun[];
  onSelectRun?: (id: string) => Promise<DigestRunDetail>;
  onRefreshRuns?: () => Promise<void>;
  nextRunCursor?: string;
  loadingMoreRuns?: boolean;
  onLoadMoreRuns?: () => Promise<void>;
}

type RuleDraft = {
  label: string;
  kind: InterestRuleKind;
  disposition: InterestRuleDisposition;
  expiresAt: string;
};

type StoryCapPreset = "concise" | "standard" | "comprehensive" | "custom";
type ProfileView = "preferences" | "interests" | "activity";

function storyCapPresetFor(value: number | null): StoryCapPreset {
  if (value === null) return "standard";
  if (value === 8) return "concise";
  if (value === 20) return "comprehensive";
  return "custom";
}

function storyCapValueFor(preset: StoryCapPreset): string | null {
  if (preset === "concise") return "8";
  if (preset === "comprehensive") return "20";
  if (preset === "standard") return null;
  return null;
}

const kindLabel: Record<InterestRuleKind, string> = {
  topic: "Topic",
  entity: "Entity",
  phrase: "Phrase",
  story_type: "Story type",
};

const dispositionLabel: Record<InterestRuleDisposition, string> = {
  prioritize: "Prioritize",
  show_less: "Show less",
  mute: "Mute",
};

const dispositionDescription: Record<InterestRuleDisposition, string> = {
  prioritize: "Bring strong matches forward in your digest.",
  show_less: "Keep matches available, but lower their prominence.",
  mute: "Leave matching stories out of your digest.",
};

const storyDetailDescription: Record<StoryDetailLevel, string> = {
  headlines: "A quick scan with the essential point and context.",
  balanced: "A clear explanation of the key points and why they matter.",
  thorough: "More context, nuance, and connections between sources.",
};

const profileViews: Array<{ id: ProfileView; label: string; description: string }> = [
  {
    id: "preferences",
    label: "Preferences",
    description: "Shape how each digest reads.",
  },
  {
    id: "interests",
    label: "Interests",
    description: "Tune the subjects you see.",
  },
  {
    id: "activity",
    label: "Activity",
    description: "Review recent digest runs.",
  },
];

function dateInputValue(expiresAt: number | null): string {
  return expiresAt === null ? "" : new Date(expiresAt).toISOString().slice(0, 10);
}

export default function ProfilePanel(props: ProfilePanelProps) {
  const [activeView, setActiveView] = createSignal<ProfileView>("preferences");
  const [name, setName] = createSignal(props.user.name);
  const [systemPrompt, setSystemPrompt] = createSignal(props.user.systemPrompt);
  const [summaryPrompt, setSummaryPrompt] = createSignal(props.user.summaryPrompt);
  const [defaultLanguage, setDefaultLanguage] = createSignal(
    props.user.defaultLanguage ?? "",
  );
  const [defaultRelevanceFilterMode, setDefaultRelevanceFilterMode] =
    createSignal(props.user.defaultRelevanceFilterMode);
  const [storyDetailLevel, setStoryDetailLevel] = createSignal<StoryDetailLevel>(
    props.user.storyDetailLevel,
  );
  const [relevanceThreshold, setRelevanceThreshold] = createSignal(
    String(props.user.relevanceThreshold),
  );
  const [maximumStoriesPerDigest, setMaximumStoriesPerDigest] = createSignal(
    props.user.maximumStoriesPerDigest === null
      ? ""
      : String(props.user.maximumStoriesPerDigest),
  );
  const [storyCapPreset, setStoryCapPreset] = createSignal<StoryCapPreset>(
    storyCapPresetFor(props.user.maximumStoriesPerDigest),
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

  const handleStoryCapPresetChange = (preset: StoryCapPreset) => {
    setStoryCapPreset(preset);
    const value = storyCapValueFor(preset);
    if (preset !== "custom") {
      setMaximumStoriesPerDigest(value ?? "");
    }
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
    if (maximum !== null && (!Number.isInteger(maximum) || maximum <= 0)) {
      setError("Maximum stories must be a positive whole number or blank.");
      return;
    }
    setSaving(true);
    try {
      const updatedUser = await props.onSave({
        name: name(),
        systemPrompt: systemPrompt(),
        summaryPrompt: summaryPrompt(),
        defaultLanguage: defaultLanguage().trim() === "" ? null : defaultLanguage(),
        defaultRelevanceFilterMode: defaultRelevanceFilterMode(),
        storyDetailLevel: storyDetailLevel(),
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
      fallback={<p class="profile-empty">No active rules in this section yet.</p>}
    >
      <div class="interest-rule-list">
        <For each={rules}>
          {(rule) => {
            const draft = () => draftFor(rule);
            const isMutating = () => props.interestMutationId === rule.id;
            return (
              <article class="interest-rule" aria-busy={isMutating()}>
                <div class="interest-rule-summary">
                  <div>
                    <h4>{rule.label}</h4>
                    <p class="interest-rule-meta">
                      {kindLabel[rule.kind]} · {rule.origin === "inferred" ? "Inferred from reading" : "Added by you"}
                      <Show when={rule.expiresAt !== null}>
                        {" · Expires "}{new Date(rule.expiresAt!).toLocaleDateString()}
                      </Show>
                    </p>
                  </div>
                  <span class={`badge interest-badge interest-badge-${rule.disposition}`}>
                    {dispositionLabel[rule.disposition]}
                  </span>
                </div>
                <p class="hint interest-rule-description">{dispositionDescription[rule.disposition]}</p>
                <details class="interest-rule-edit">
                  <summary>Edit rule</summary>
                  <div class="interest-rule-fields">
                    <div class="form-group">
                      <label for={`interest-label-${rule.id}`}>Rule label</label>
                      <input
                        id={`interest-label-${rule.id}`}
                        value={draft().label}
                        onInput={(e) => updateDraft(rule, { label: e.currentTarget.value })}
                      />
                    </div>
                    <div class="form-group">
                      <label for={`interest-kind-${rule.id}`}>What kind of interest is this?</label>
                      <select
                        id={`interest-kind-${rule.id}`}
                        value={draft().kind}
                        onChange={(e) => updateDraft(rule, { kind: e.currentTarget.value as InterestRuleKind })}
                      >
                        <option value="topic">Topic</option>
                        <option value="entity">Person or organization</option>
                        <option value="phrase">Exact phrase</option>
                        <option value="story_type">Story type</option>
                      </select>
                    </div>
                    <div class="form-group">
                      <label for={`interest-disposition-${rule.id}`}>How should it affect your digest?</label>
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
                        <option value="mute">Mute</option>
                      </select>
                    </div>
                    <Show when={draft().disposition === "mute"}>
                      <div class="form-group">
                        <label for={`interest-expiry-${rule.id}`}>Stop muting on (optional)</label>
                        <input
                          id={`interest-expiry-${rule.id}`}
                          type="date"
                          value={draft().expiresAt}
                          onInput={(e) => updateDraft(rule, { expiresAt: e.currentTarget.value })}
                        />
                      </div>
                    </Show>
                  </div>
                  <div class="profile-inline-actions">
                    <button type="button" class="primary" disabled={isMutating()} onClick={() => saveRule(rule)}>
                      {isMutating() ? "Saving…" : "Save rule"}
                    </button>
                    <button
                      type="button"
                      class="danger"
                      disabled={isMutating()}
                      onClick={() => removeInterest(rule)}
                      aria-label={`Delete rule ${rule.label}`}
                    >
                      Delete rule
                    </button>
                  </div>
                </details>
              </article>
            );
          }}
        </For>
      </div>
    </Show>
  );

  const rulesFor = (disposition: InterestRuleDisposition) =>
    props.interests.filter((rule) => rule.disposition === disposition && rule.state === "active");

  const renderPreferences = () => (
    <form class="profile-preferences" onSubmit={handleSubmit}>
      <section class="profile-section" aria-labelledby="profile-reading-heading">
        <div class="profile-section-heading">
          <h2 id="profile-reading-heading">Reading defaults</h2>
          <p>Set the baseline voice and depth for every digest. You can still tune individual feeds later.</p>
        </div>
        <div class="profile-form-grid">
          <div class="form-group">
            <label for="profile-name">Your name</label>
            <input id="profile-name" type="text" required value={name()} onInput={(e) => setName(e.currentTarget.value)} />
            <p class="hint">Used to personalize your briefing and account.</p>
          </div>
          <div class="form-group">
            <label for="profile-language">Digest language</label>
            <input
              id="profile-language"
              type="text"
              value={defaultLanguage()}
              onInput={(e) => setDefaultLanguage(e.currentTarget.value)}
              placeholder="Auto-detect"
            />
            <p class="hint">Leave blank to let Morning Post detect the language of your sources.</p>
          </div>
        </div>
        <div class="form-group">
          <label for="profile-story-detail">How much context should stories include?</label>
          <select
            id="profile-story-detail"
            aria-describedby="profile-story-detail-hint"
            value={storyDetailLevel()}
            onChange={(e) => setStoryDetailLevel(e.currentTarget.value as StoryDetailLevel)}
          >
            <option value="headlines">Headlines — scan the essentials</option>
            <option value="balanced">Balanced — understand the key points</option>
            <option value="thorough">Thorough — explore more context and nuance</option>
          </select>
          <p id="profile-story-detail-hint" class="hint">{storyDetailDescription[storyDetailLevel()]}</p>
        </div>
      </section>

      <section class="profile-section" aria-labelledby="profile-digest-heading">
        <div class="profile-section-heading">
          <h2 id="profile-digest-heading">Digest shape</h2>
          <p>Choose how much reading fits comfortably into one sitting.</p>
        </div>
        <div class="form-group">
          <label for="profile-story-cap-preset">Digest size</label>
          <select
            id="profile-story-cap-preset"
            value={storyCapPreset()}
            onChange={(e) => handleStoryCapPresetChange(e.currentTarget.value as StoryCapPreset)}
          >
            <option value="concise">Concise — 8 stories</option>
            <option value="standard">Standard — {DEFAULT_MAXIMUM_STORIES_PER_DIGEST} stories (default)</option>
            <option value="comprehensive">Comprehensive — 20 stories</option>
            <option value="custom">Custom</option>
          </select>
          <p class="hint">Presets keep the rhythm consistent; custom lets you choose your own ceiling.</p>
        </div>
        <div class="form-group">
          <label for="profile-max-stories">Maximum stories per digest</label>
          <input
            id="profile-max-stories"
            type="number"
            min="1"
            step="1"
            placeholder={`Default (${DEFAULT_MAXIMUM_STORIES_PER_DIGEST})`}
            aria-describedby="profile-max-stories-hint"
            value={maximumStoriesPerDigest()}
            onInput={(e) => {
              const value = e.currentTarget.value;
              setMaximumStoriesPerDigest(value);
              setStoryCapPreset(value.trim() === "" ? "standard" : "custom");
            }}
          />
          <p id="profile-max-stories-hint" class="hint">Standard uses the default {DEFAULT_MAXIMUM_STORIES_PER_DIGEST}-story cap.</p>
        </div>
      </section>

      <section class="profile-section" aria-labelledby="profile-relevance-heading">
        <div class="profile-section-heading">
          <h2 id="profile-relevance-heading">Relevance</h2>
          <p>Decide how strongly Morning Post should filter stories against your interests.</p>
        </div>
        <div class="form-group">
          <label for="profile-relevance-mode">Default filtering mode</label>
          <select
            id="profile-relevance-mode"
            value={defaultRelevanceFilterMode()}
            onChange={(e) => setDefaultRelevanceFilterMode(e.currentTarget.value as "personalized" | "include_all")}
          >
            <option value="personalized">Personalized — use my interests</option>
            <option value="include_all">Include all — do not filter by relevance</option>
          </select>
          <p class="hint">Personalized keeps your reading focused; include all is useful when exploring a new source.</p>
        </div>
        <div class="form-group profile-range-group">
          <label for="profile-threshold">Relevance threshold <output for="profile-threshold">{relevanceThreshold()}</output></label>
          <input
            id="profile-threshold"
            type="range"
            min="0"
            max="100"
            step="1"
            value={relevanceThreshold()}
            onInput={(e) => setRelevanceThreshold(e.currentTarget.value)}
          />
          <p class="hint">{thresholdDescription()}. Higher values make the digest more selective.</p>
        </div>
      </section>

      <section class="profile-section" aria-labelledby="profile-advanced-heading">
        <details class="profile-advanced">
          <summary id="profile-advanced-heading">Advanced instructions</summary>
          <p class="hint">Use these prompts only when the defaults do not capture your editorial voice. Raw prompt editing is optional.</p>
          <div class="form-group">
            <label for="profile-prompt">Interest instructions</label>
            <textarea id="profile-prompt" rows={5} value={systemPrompt()} onInput={(e) => setSystemPrompt(e.currentTarget.value)} />
            <p class="hint">Additional context for deciding which stories match your interests.</p>
          </div>
          <div class="form-group">
            <label for="profile-summary-prompt">Summary writing instructions</label>
            <textarea id="profile-summary-prompt" rows={5} value={summaryPrompt()} onInput={(e) => setSummaryPrompt(e.currentTarget.value)} />
            <p class="hint">Guide tone, detail, and format without changing relevance filtering.</p>
          </div>
        </details>
      </section>

      <div class="profile-save-bar" role="group" aria-label="Save profile preferences">
        <div>
          <strong>Keep your desk tuned</strong>
          <p class="hint" aria-live="polite">{saving() ? "Saving your preferences…" : saved() ? "Preferences saved." : "Changes stay here until you save."}</p>
        </div>
        <button type="submit" class="primary" disabled={saving()}>{saving() ? "Saving…" : "Save preferences"}</button>
      </div>
      <Show when={error()}>
        <div class="error profile-form-error" role="alert">{error()}</div>
      </Show>
    </form>
  );

  const renderInterests = () => (
    <div class="profile-interests">
      <section class="profile-section" aria-labelledby="interests-heading">
        <div class="profile-section-heading">
          <h2 id="interests-heading">Interests</h2>
          <p>Rules shape relevance without hiding the source. Explicit rules are yours; inferred rules come from your reading patterns.</p>
        </div>
        <Show when={props.interestsError}>
          <div class="error" role="alert">{props.interestsError}</div>
        </Show>
        <Show when={!props.interestsLoading} fallback={<p class="profile-loading" role="status">Loading your interest profile…</p>}>
          <div class="interest-groups">
            <section class="interest-group" aria-labelledby="prioritize-heading">
              <div class="interest-group-heading"><h3 id="prioritize-heading">Prioritize</h3><p>Bring these subjects forward.</p></div>
              {renderRules(rulesFor("prioritize"))}
            </section>
            <section class="interest-group" aria-labelledby="show-less-heading">
              <div class="interest-group-heading"><h3 id="show-less-heading">Show less</h3><p>Keep these subjects, with less emphasis.</p></div>
              {renderRules(rulesFor("show_less"))}
            </section>
            <section class="interest-group interest-group-muted" aria-labelledby="muted-heading">
              <div class="interest-group-heading"><h3 id="muted-heading">Mute</h3><p>Matching stories stay out until a rule expires or you delete it.</p></div>
              {renderRules(rulesFor("mute"))}
            </section>
          </div>
        </Show>
      </section>

      <section class="profile-section profile-add-interest" aria-labelledby="add-interest-heading">
        <details open>
          <summary id="add-interest-heading">Add an interest rule</summary>
          <p class="hint">Start with one clear topic, person, phrase, or story type.</p>
          <form onSubmit={addInterest}>
            <div class="profile-form-grid">
              <div class="form-group">
                <label for="interest-label">What should Morning Post notice?</label>
                <input id="interest-label" required value={newLabel()} onInput={(e) => setNewLabel(e.currentTarget.value)} placeholder="e.g. urban planning" />
              </div>
              <div class="form-group">
                <label for="interest-kind">Interest type</label>
                <select id="interest-kind" value={newKind()} onChange={(e) => setNewKind(e.currentTarget.value as InterestRuleKind)}>
                  <option value="topic">Topic</option>
                  <option value="entity">Person or organization</option>
                  <option value="phrase">Exact phrase</option>
                  <option value="story_type">Story type</option>
                </select>
              </div>
            </div>
            <div class="profile-form-grid">
              <div class="form-group">
                <label for="interest-disposition">How should it affect your digest?</label>
                <select id="interest-disposition" value={newDisposition()} onChange={(e) => setNewDisposition(e.currentTarget.value as InterestRuleDisposition)}>
                  <option value="prioritize">Prioritize</option>
                  <option value="show_less">Show less</option>
                  <option value="mute">Mute</option>
                </select>
              </div>
              <Show when={newDisposition() === "mute"}>
                <div class="form-group">
                  <label for="interest-expiry">Stop muting on (optional)</label>
                  <input id="interest-expiry" type="date" value={newExpiresAt()} onInput={(e) => setNewExpiresAt(e.currentTarget.value)} />
                </div>
              </Show>
            </div>
            <Show when={interestFormError()}>
              <div class="error" role="alert">{interestFormError()}</div>
            </Show>
            <button type="submit" class="primary" disabled={props.interestMutationId === "new"}>
              {props.interestMutationId === "new" ? "Adding…" : "Add rule"}
            </button>
          </form>
        </details>
      </section>
    </div>
  );

  const renderActivity = () => (
    <section class="profile-activity" aria-labelledby="profile-activity-title">
      <div class="profile-section-heading profile-activity-intro">
        <h2 id="profile-activity-title">Activity</h2>
        <p>See what Morning Post prepared recently. Open a digest to read it; technical feed steps stay tucked away until you need them.</p>
      </div>
      <Show
        when={props.runs && props.onSelectRun && props.onRefreshRuns}
        fallback={<p class="profile-empty">Run a digest to start building your activity history.</p>}
      >
        <DigestRunsPanel
          runs={props.runs!}
          onSelectRun={props.onSelectRun!}
          onRefresh={props.onRefreshRuns!}
          onAuthError={props.onAuthError}
          nextCursor={props.nextRunCursor}
          loadingMore={props.loadingMoreRuns}
          onLoadMore={props.onLoadMoreRuns}
        />
      </Show>
    </section>
  );

  return (
    <section class="profile-workspace" aria-labelledby="profile-title">
      <header class="profile-workspace-header">
        <p class="app-content-kicker">Your desk</p>
        <h1 id="profile-title">Profile</h1>
        <p>Set the editorial defaults that make Morning Post feel like your own newspaper.</p>
      </header>
      <nav class="profile-tabs" role="tablist" aria-label="Profile workspace views">
        <For each={profileViews}>
          {(view) => (
            <button
              type="button"
              role="tab"
              class="profile-tab"
              aria-selected={activeView() === view.id}
              aria-controls={`profile-view-${view.id}`}
              id={`profile-tab-${view.id}`}
              onClick={() => setActiveView(view.id)}
            >
              <span>{view.label}</span>
              <small>{view.description}</small>
            </button>
          )}
        </For>
      </nav>
      <div id={`profile-view-${activeView()}`} role="tabpanel" aria-labelledby={`profile-tab-${activeView()}`} class="profile-view">
        <Show when={activeView() === "preferences"}>{renderPreferences()}</Show>
        <Show when={activeView() === "interests"}>{renderInterests()}</Show>
        <Show when={activeView() === "activity"}>{renderActivity()}</Show>
      </div>
    </section>
  );
}
